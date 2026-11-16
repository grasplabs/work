import type { BrainUploadReaders } from "@grasp-os/shared/brain-sources";
import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { withheldResult } from "../src/agent.ts";
import { organizationId } from "../src/auth/auth.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { workspace } from "../src/durable-objects.ts";
import { chatOf, codeResults, codeStep, says } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi, unique } from "./sign-in.ts";

// Who knows about a topic, for a chat's code (GRA-1744; the design note
// and threat model are on the issue): `env.brain.whoKnows` names the
// people who uploaded the documents about it that the chat's person may
// read, each with the versions that say so. How it can fail, and what
// each test holds it to:
// 1. A person is named on the strength of a document the asker may not
//    read: a team's they aren't in, one its uploader alone reads, or one
//    removed. None names anyone.
// 2. What only one person may read becomes evidence: the asker's own
//    upload for themselves alone names nobody, them included.
// 3. An erased or removed person is named: never.
// 4. Monitoring: people by name, never by how much they uploaded.
// 5. It reads wider than its recall: at the same reach, in Grasp and in
//    a chat app's direct message alike (their teams and the company).
// 6. A named person outlives what it rests on in the chat's history:
//    every version cited is pinned, so a later turn withholds the answer
//    once the document is gone.
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
        sources: z.array(
          z.strictObject({
            source: z.strictObject({
              producer: z.literal("upload"),
              id: z.string(),
            }),
            version: z.number(),
          })
        ),
      })
    ),
    notFound: z.array(z.string()),
    truncated: z.boolean(),
  }),
  z.strictObject({ failed: z.string() }),
]);

/** What the chat's code returned, each step's answer. */
const answersIn = async (
  stub: Parameters<typeof codeResults>[0],
  chatId: string
) => {
  const results = await codeResults(stub, chatId);
  return results.map(({ text }) =>
    answerSchema.parse(JSON.parse(text.replace(/^Returned:\n/u, "")))
  );
};

/**
 * Each person `answer` names, by id, with the uploads that say so: read
 * by the people a test made, never as a whole list (recall may find more
 * by meaning).
 */
const namedIn = (
  answer: z.infer<typeof answerSchema> | undefined
): Map<string, string[]> => {
  if (answer === undefined || "failed" in answer) {
    throw new Error(`No answer: ${JSON.stringify(answer)}`);
  }
  return new Map(
    answer.people.map(({ id, sources }) => [
      id,
      sources.map(({ source }) => source.id),
    ])
  );
};

/** What `named` says of each of `people`: their uploads, or null when not named. */
const of = (
  named: Map<string, string[]>,
  people: Readonly<Record<string, Person>>
) =>
  Object.fromEntries(
    Object.entries(people).map(([key, { userId }]) => [
      key,
      named.get(userId)?.toSorted() ?? null,
    ])
  );

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

/** What `person` asks in their direct message with a new agent of theirs on Teams. */
const askedInDirectMessage = async (
  admin: Person,
  person: Person,
  question: string
) => {
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

describe("a chat's code asking who knows about a topic", setUpTime, () => {
  it("names who uploaded the documents about it that its person may read, by name, each with what says so, and nobody on the strength of anything else", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, mate, colleague, stranger, remover, leaver, erased] =
      await Promise.all([
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
        signedInApi(idp, "user"),
      ]);
    const topic = word();
    const ownTeam = await teamOf(asker, mate);
    const otherTeam = await teamOf(stranger);
    const everyone: BrainUploadReaders = { kind: "everyone" };
    const ofTeam = await uploaded(mate, `Pricing ${topic}`, {
      kind: "team",
      teamId: ownTeam,
    });
    const forEveryone = await uploaded(
      colleague,
      `Pricing ${topic} for all`,
      everyone
    );
    const secondForEveryone = await uploaded(
      colleague,
      `More on ${topic}`,
      everyone
    );
    // None of these may name anyone to the asker.
    await uploaded(stranger, `Pricing ${topic}`, {
      kind: "team",
      teamId: otherTeam,
    });
    await uploaded(stranger, `Pricing ${topic}, mine`, { kind: "me" });
    await uploaded(asker, `Pricing ${topic}, my own`, { kind: "me" });
    const removed = await uploaded(remover, `Pricing ${topic} old`, everyone);
    await remover.api.brainSources.deleteUpload(removed);
    await uploaded(leaver, `Pricing ${topic} by a leaver`, everyone);
    await uploaded(erased, `Pricing ${topic} by the erased`, everyone);
    await admin.api.members.remove(leaver.userId);
    await admin.api.members.remove(erased.userId);
    await admin.api.members.erase(erased.userId, String(erased.person.name));

    const chat = await ownChatOf(
      admin,
      asker,
      askingCode(topic),
      says("Asked.")
    );
    await chat.ask(word());
    const [answer] = await answersIn(chat.stub, chat.chat.id);
    const named = namedIn(answer);

    expect(
      of(named, {
        mate,
        colleague,
        stranger,
        asker,
        remover,
        leaver,
        erased,
      })
    ).toStrictEqual({
      mate: [ofTeam],
      colleague: [forEveryone, secondForEveryone].toSorted(),
      stranger: null,
      asker: null,
      remover: null,
      leaver: null,
      erased: null,
    });
    // Each by their name as a member, the people in the order of their
    // names: never by how much they uploaded.
    const people =
      answer !== undefined && "people" in answer ? answer.people : [];
    expect({
      mate: people.find(({ id }) => id === mate.userId)?.name,
      inOrder: people.map(({ name }) => name),
    }).toStrictEqual({
      mate: String(mate.person.name),
      inOrder: people
        .map(({ name }) => name)
        .toSorted((one, other) => one.localeCompare(other)),
    });
  });

  it("reads at its recall's reach: in a chat app's direct message, the company's documents, its person's teams' too", async () => {
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

    const named = namedIn(await askedInDirectMessage(admin, asker, topic));
    expect(of(named, { mate, colleague })).toStrictEqual({
      mate: [ofTeam],
      colleague: [forEveryone],
    });
  });

  it("withholds its answer from a later turn once a document it rests on is erased", async () => {
    const admin = await signedInApi(idp, "admin");
    const [asker, colleague] = await Promise.all([
      signedInApi(idp, "user"),
      signedInApi(idp, "user"),
    ]);
    const topic = word();
    const upload = await uploaded(colleague, `Budget ${topic}`, {
      kind: "everyone",
    });
    const chat = await ownChatOf(
      admin,
      asker,
      askingCode(topic),
      says("Asked."),
      says("And now.")
    );
    await chat.ask(word());
    const [answer] = await answersIn(chat.stub, chat.chat.id);
    expect(of(namedIn(answer), { colleague })).toStrictEqual({
      colleague: [upload],
    });
    const before = chat.provider.requests.length;
    // An admin's delete of a shared upload erases it for good.
    await admin.api.brainSources.deleteUpload(upload);
    await chat.ask(word());
    const sent = JSON.stringify(chat.provider.requests[before]?.body);
    expect({
      named: sent.includes(colleague.userId),
      withheld: sent.includes(withheldResult),
    }).toStrictEqual({ named: false, withheld: true });
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
      answered: of(namedIn(answered), { colleague }),
      events: events.map(({ detail }) => ({
        onBehalfOf: detail?.onBehalfOf,
        keys: Object.keys(detail ?? {}).toSorted(),
      })),
    }).toStrictEqual({
      answered: { colleague: [upload] },
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

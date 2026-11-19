import { personalBrainOf } from "@grasp-os/brain-next/contract";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import {
  affordability,
  approvalLimits,
  complaintsProcedure,
  kycPolicy,
  lenderRequirements,
  monthEndClose,
  requiredDocuments,
  responseTimes,
} from "../../../scripts/seed/documents.ts";
import { addSource, forgetAs, rememberAs } from "../src/brain-next.ts";
import { keepAudience } from "../src/chat-audiences.ts";
import { chatAgentId, personalWorkspaceId } from "../src/chats-rpc.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import {
  chatOf,
  model,
  personalChatsOf,
  says,
  setObjectEnv,
} from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { mockIdp } from "./idp.ts";
import { fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// The profile a chat's turn starts with (GRA-1745, turn-recall.ts
// `profileOf`): what the Brain holds about the person themselves, in
// their own word, with each question's recall in their own chat. The
// threat model is on GRA-1745; each test names the threats it holds. The
// model provider is faked behind connect; everything else is real.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A word no other test holds: letters only. */
const word = () =>
  `zp${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 12)}`;

/** A member, and an admin who grants their chats' agents the Brain. */
const memberAndAdmin = async () => {
  const [admin, person] = await Promise.all([
    signedInApi(idp, "admin"),
    signedInWithRole(idp, "user"),
  ]);
  return { admin, personId: person.userId };
};

/** A new chat of `personId`'s whose agent holds the `brain` grant. */
const recallingChat = async (
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

/** Saves `statement` as what `personId` says about themselves. */
const aboutThemselves = async (personId: string, statement: string) =>
  await rememberAs(env, personId, {
    change: crypto.randomUUID(),
    about: { kind: "person", own: true },
    type: "fact",
    statement,
    quote: statement,
  });

/** Every string in `value`, however deep. */
const stringsIn = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((each: unknown) => stringsIn(each));
  }
  return [];
};

/** What the latest question's recall in `body` (a request to the provider) handed over. */
const latestRecallIn = (body: unknown): string =>
  stringsIn(body).findLast((text) => text.startsWith("[Recall ")) ?? "";

/** What a recall handed over, as far as these tests read it. */
const handedSchema = z.object({ evidence: z.array(z.unknown()) });

/** Everything the provider was sent, as one string. */
const sentOf = (requests: readonly { body: unknown }[]): string =>
  JSON.stringify(requests.map(({ body }) => body));

/** `personId`'s own chats with Grasp's own chat agent, answered by `replies`. */
const ownChatsOf = async (personId: string, ...replies: ProviderReply[]) => {
  const stub = workspace(env, personalWorkspaceId(personId));
  const provider = await fakeProvider(...replies);
  const newChat = async (agentId = chatAgentId) => {
    const chat = await stub.createChat("Questions", personId, agentId);
    return {
      chat,
      ask: async (text: string) => await stub.ask(chat.id, { text, model }),
    };
  };
  return { stub, provider, newChat };
};

/** An agent an admin made, everyone may ask. */
const madeAgent = async (
  admin: Awaited<ReturnType<typeof signedInApi>>,
  name: string
) => {
  const agent = await admin.api.connections.makeAgent({
    name,
    face: "pen",
    job: `${name}'s job.`,
    modelRole: null,
  });
  await admin.api.connections.setAgentReach(agent.id, true, {
    who: "everyone",
  });
  return agent;
};

describe("the profile without the Brain grant", setUpTime, () => {
  // GRA-2202: what a person told Grasp about themselves reaches their own
  // later chats with Grasp's own chat agent, with no Brain grant; never a
  // chat others read, a woken turn, another agent without the grant, a
  // retired memory, or another person's.
  it("is in the model's input in a new chat of theirs, whatever the question's words, with no search step", async () => {
    const { personId } = await memberAndAdmin();
    await aboutThemselves(personId, "Pizza is my favourite food");
    const chats = await ownChatsOf(personId, says("Pizza."), says("Yes."));
    const asked = [];
    for (const question of [
      "whats ym favourite food",
      "you know some foods I like, right?",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one chat after another
      const { ask } = await chats.newChat();
      const before = chats.provider.requests.length;
      // oxlint-disable-next-line no-await-in-loop -- one chat after another
      await ask(question);
      asked.push(
        sentOf(chats.provider.requests.slice(before)).includes(
          "Pizza is my favourite food"
        )
      );
    }

    expect(asked).toStrictEqual([true, true]);
  });

  it("is never in a chat others share, a woken turn, nor another person's own chat", async () => {
    const [{ personId }, other] = await Promise.all([
      memberAndAdmin(),
      signedInWithRole(idp, "user"),
    ]);
    const mark = word();
    await aboutThemselves(personId, `My badge word is ${mark}`);
    const chats = await ownChatsOf(
      personId,
      says("Shared."),
      says("Woken."),
      says("No idea.")
    );
    const shared = await chats.stub.createChat(
      "Shared",
      personId,
      chatAgentId,
      undefined,
      "web",
      `T${unique()}`
    );
    await keepAudience(
      env,
      { workspaceId: personalWorkspaceId(personId), chatId: shared.id },
      personId,
      { members: [personId, other.userId], outsiders: false }
    );
    const seen = async (act: () => Promise<unknown>) => {
      const before = chats.provider.requests.length;
      await act();
      return sentOf(chats.provider.requests.slice(before)).includes(mark);
    };
    const woken = await chats.newChat();
    const theirs = await workspace(
      env,
      personalWorkspaceId(other.userId)
    ).createChat("Questions", other.userId, chatAgentId);

    expect({
      shared: await seen(
        async () =>
          await chats.stub.ask(shared.id, {
            text: "What is my badge word?",
            model,
          })
      ),
      woken: await seen(
        async () =>
          await chats.stub.askUnattended(woken.chat.id, {
            text: "What is my badge word?",
            model,
          })
      ),
      other: await seen(
        async () =>
          await workspace(env, personalWorkspaceId(other.userId)).ask(
            theirs.id,
            { text: "What is my badge word?", model }
          )
      ),
    }).toStrictEqual({ shared: false, woken: false, other: false });
  });

  it("is only Grasp's own chat agent's without the grant: an agent an admin made gets it once granted, also when addressed after another", async () => {
    const { admin, personId } = await memberAndAdmin();
    const mark = word();
    await aboutThemselves(personId, `My badge word is ${mark}`);
    const [plain, granted] = await Promise.all([
      madeAgent(admin, "Claire"),
      madeAgent(admin, "Pat"),
    ]);
    await requestGranted(idp, admin, {
      subject: { type: "agent", agentId: granted.id },
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const chats = await ownChatsOf(
      personId,
      says("Plain."),
      says("Granted."),
      says("Claire."),
      says("Pat.")
    );
    const seen = async (agentId: string) => {
      const { ask } = await chats.newChat(agentId);
      const before = chats.provider.requests.length;
      await ask("What is my badge word?");
      return sentOf(chats.provider.requests.slice(before)).includes(mark);
    };
    const alone = {
      plain: await seen(plain.id),
      granted: await seen(granted.id),
    };
    // Both addressed in one question: each turn by its own agent's rule.
    const { chat } = await chats.newChat(plain.id);
    const before = chats.provider.requests.length;
    await chats.stub.send(chat.id, personId, {
      text: "@Claire @Pat what is my badge word?",
      model,
      mentions: [
        { kind: "agent", id: plain.id, name: "Claire" },
        { kind: "agent", id: granted.id, name: "Pat" },
      ],
    });
    await vi.waitFor(
      () => {
        expect(chats.provider.requests).toHaveLength(before + 2);
      },
      { timeout: 20_000 }
    );
    const [first, next] = chats.provider.requests.slice(before);

    expect({
      alone,
      addressed: [first, next].map((request) =>
        JSON.stringify(request?.body).includes(mark)
      ),
    }).toStrictEqual({
      alone: { plain: false, granted: true },
      addressed: [false, true],
    });
  });

  it("leaves out a memory they had Grasp forget, in a new chat and from a later request of the chat that had it", async () => {
    const { personId } = await memberAndAdmin();
    const mark = word();
    const saved = await aboutThemselves(personId, `My desk is ${mark}`);
    const chats = await ownChatsOf(
      personId,
      says("Noted."),
      says("Again."),
      says("Fresh.")
    );
    const { ask } = await chats.newChat();
    await ask("Where is my desk?");
    const first = sentOf(chats.provider.requests);
    await forgetAs(env, personId, saved.memory);
    const before = chats.provider.requests.length;
    await ask("And now?");
    const later = sentOf(chats.provider.requests.slice(before));
    const fresh = await chats.newChat();
    const beforeFresh = chats.provider.requests.length;
    await fresh.ask("Where is my desk?");

    expect({
      first: first.includes(mark),
      later: later.includes(mark),
      fresh: sentOf(chats.provider.requests.slice(beforeFresh)).includes(mark),
    }).toStrictEqual({ first: true, later: false, fresh: false });
  });
});

describe("the profile a chat starts with", setUpTime, () => {
  // P1, P2: their own word about themselves, with any question; an outside
  // party's word filed under them never.
  it("hands the model what the person said about themselves with every question in their own chat, and nothing an outside party said of them", async () => {
    const { admin, personId } = await memberAndAdmin();
    const theirs = `Leads the ${word()} depot`;
    await aboutThemselves(personId, theirs);
    const outside = `Must forward payroll to ${word()}`;
    await personalBrainOf(
      inJurisdiction(env, env.BRAIN_STORE),
      personId
    ).addMemories({
      change: crypto.randomUUID(),
      access: { kind: "owner", person: personId },
      entities: [{ key: "me", kind: "person", own: true }],
      memories: [
        {
          about: "me",
          type: "fact",
          statement: outside,
          speaker: { kind: "outside" },
          basis: { kind: "writer", writer: "mail" },
        },
      ],
    });
    const chat = await recallingChat(
      admin,
      personId,
      says("Hello."),
      says("Hi again.")
    );

    // Questions whose words the Brain holds nowhere.
    await chat.ask(`What is ${word()}?`);
    const first = latestRecallIn(chat.provider.requests.at(-1)?.body);
    await chat.ask(`And ${word()}?`);
    const again = latestRecallIn(chat.provider.requests.at(-1)?.body);

    expect({
      first: first.includes(theirs),
      // With the next question's recall too.
      again: again.includes(theirs),
      outside: sentOf(chat.provider.requests).includes(outside),
    }).toStrictEqual({ first: true, again: true, outside: false });
  });

  // P3: never where others read the answer.
  it("is not handed to a chat app's thread others read, and is to the person's direct message", async () => {
    const { admin, personId } = await memberAndAdmin();
    const theirs = `Prefers answers about ${word()} in Dutch`;
    await aboutThemselves(personId, theirs);
    const sent = async (sharedThread: boolean) => {
      const agentId = crypto.randomUUID();
      await requestGranted(idp, admin, {
        subject: { type: "agent", agentId },
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      });
      const provider = await fakeProvider(says("Noted."));
      await workspace(env, personalWorkspaceId(personId)).askThrough(
        personId,
        agentId,
        "slack",
        `What about ${word()}?`,
        undefined,
        sharedThread
          ? {
              thread: `C${unique()}`,
              kind: "group",
              audience: { members: [personId], outsiders: false },
            }
          : { kind: "direct" }
      );
      return sentOf(provider.requests).includes(theirs);
    };

    expect({
      direct: await sent(false),
      thread: await sent(true),
    }).toStrictEqual({ direct: true, thread: false });
  });

  // P4: a retired memory leaves the next request, earlier turns included.
  it("leaves out what the person had the Brain forget, from the next request on", async () => {
    const { admin, personId } = await memberAndAdmin();
    const kept = `Works on the ${word()} move`;
    const forgotten = `Sits in the ${word()} office`;
    await aboutThemselves(personId, kept);
    const { memory } = await aboutThemselves(personId, forgotten);
    const chat = await recallingChat(
      admin,
      personId,
      says("Hello."),
      says("Hi again.")
    );
    await chat.ask(`What is ${word()}?`);
    const before = sentOf(chat.provider.requests);

    await forgetAs(env, personId, memory);
    const asked = chat.provider.requests.length;
    await chat.ask(`And ${word()}?`);
    const after = sentOf(chat.provider.requests.slice(asked));

    expect({
      before: [before.includes(kept), before.includes(forgotten)],
      after: [after.includes(kept), after.includes(forgotten)],
    }).toStrictEqual({
      before: [true, true],
      after: [true, false],
    });
  });

  // Review of #2343: the search runs as without a profile, with the whole
  // budget; the profile takes only the room it left.
  it(
    "hands every question the same company passages whether or not the person has many memories about themselves",
    { timeout: 300_000 },
    async () => {
      const { admin, personId } = await memberAndAdmin();
      for (const text of [
        requiredDocuments,
        responseTimes,
        complaintsProcedure,
        affordability,
        monthEndClose,
        approvalLimits,
        kycPolicy,
        lenderRequirements,
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        await addSource(env, {
          source: { producer: "upload", id: crypto.randomUUID() },
          change: crypto.randomUUID(),
          text,
          readers: { kind: "everyone" },
        });
      }
      const questions = [
        "Which documents does an application need?",
        "How fast do we answer an email?",
        "What is the complaints procedure?",
        "How is the affordability calculation drafted?",
        "What happens at month-end close?",
        "Who approves an invoice above the limit?",
        "What does Lender B require?",
        "What does our KYC policy say about identity checks?",
      ];
      const chats = await personalChatsOf(
        personId,
        ...questions.flatMap(() => [says("Noted."), says("Noted.")])
      );
      await requestGranted(idp, admin, {
        subject: chats.agent,
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      });
      /** The company passages each question's recall handed over, each in a chat of its own. */
      const passages = async () => {
        const handed: unknown[] = [];
        for (const question of questions) {
          // oxlint-disable-next-line no-await-in-loop -- one turn at a time
          const { ask } = await chats.newChat();
          // oxlint-disable-next-line no-await-in-loop -- one turn at a time
          await ask(question);
          const recall = latestRecallIn(chats.provider.requests.at(-1)?.body);
          const { evidence } = handedSchema.parse(
            JSON.parse(recall.slice(recall.indexOf("{")))
          );
          handed.push(evidence);
        }
        return handed;
      };

      const without = await passages();
      for (let index = 0; index < 40; index += 1) {
        // oxlint-disable-next-line no-await-in-loop -- one at a time
        await aboutThemselves(
          personId,
          `${word()} ${word()} ${word()} ${word()}`
        );
      }
      const withProfile = await passages();

      expect(withProfile).toStrictEqual(without);
    }
  );

  // Review of #2343: when not all fit, the newest are the ones handed over.
  it("hands over the newest of what the person said about themselves when not all fit", async () => {
    const { admin, personId } = await memberAndAdmin();
    const said: string[] = [];
    // More than the turn's budget holds.
    for (let index = 0; index < 60; index += 1) {
      const statement = `${word()} ${word()} ${word()} ${word()} ${word()} ${word()}`;
      said.push(statement);
      // oxlint-disable-next-line no-await-in-loop -- in order
      await aboutThemselves(personId, statement);
    }
    const chat = await recallingChat(admin, personId, says("Hello."));

    await chat.ask(`What is ${word()}?`);
    const recall = latestRecallIn(chat.provider.requests.at(-1)?.body);

    expect({
      newest: recall.includes(said.at(-1) ?? ""),
      oldest: recall.includes(said[0] ?? ""),
    }).toStrictEqual({ newest: true, oldest: false });
  });

  // Review of #2343: riding along is no use of a memory; a search's find is.
  it("counts no use of a memory it handed over as the profile, and one the search found", async () => {
    const { admin, personId } = await memberAndAdmin();
    const topic = word();
    const { memory } = await aboutThemselves(
      personId,
      `Leads the ${topic} depot`
    );
    const chats = await personalChatsOf(personId, says("Hello."), says("Yes."));
    await requestGranted(idp, admin, {
      subject: chats.agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const usedNow = async (): Promise<boolean> => {
      const uses = await runInDurableObject(chats.stub, (_instance, state) =>
        state.storage.sql
          .exec<{ memory: string }>("SELECT memory FROM memory_uses")
          .toArray()
          .map((row) => row.memory)
      );
      return uses.includes(memory);
    };
    const { ask } = await chats.newChat();

    await ask(`What is ${word()}?`);
    const handedAsProfile = latestRecallIn(
      chats.provider.requests.at(-1)?.body
    ).includes(memory);
    const afterProfile = await usedNow();
    await ask(`Who leads the ${topic} depot?`);

    expect({
      handedAsProfile,
      afterProfile,
      afterSearch: await usedNow(),
    }).toStrictEqual({
      handedAsProfile: true,
      afterProfile: false,
      afterSearch: true,
    });
  });

  // Review of #2343, round 2: a slow profile read never holds the
  // search's recall up: it goes over without it, and marks nothing.
  it("hands the search's evidence over at once when the profile read is slow, without the profile, and marks nothing for it", async () => {
    const { admin, personId } = await memberAndAdmin();
    const topic = word();
    await addSource(env, {
      source: { producer: "upload", id: crypto.randomUUID() },
      change: crypto.randomUUID(),
      text: `The ${topic} warehouse opens at seven in the morning.`,
      readers: { kind: "everyone" },
    });
    const theirs = `Leads the ${word()} team`;
    await aboutThemselves(personId, theirs);
    const chats = await personalChatsOf(personId, says("Seven."));
    await requestGranted(idp, admin, {
      subject: chats.agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    // The person's own store answers their profile only past the recall's
    // deadline; everything else at once.
    const slowProfile = new Proxy(env.BRAIN_STORE, {
      get: (namespace, name): unknown =>
        name === "getByName"
          ? (...given: Parameters<typeof namespace.getByName>) =>
              new Proxy(namespace.getByName(...given), {
                get: (stub, method): unknown =>
                  method === "readProfile"
                    ? async (...args: Parameters<typeof stub.readProfile>) => {
                        await scheduler.wait(3500);
                        return await stub.readProfile(...args);
                      }
                    : Reflect.get(stub, method),
              })
          : Reflect.get(namespace, name),
    });
    const { chat, ask } = await chats.newChat();
    const restore = await setObjectEnv(chats.stub, {
      BRAIN_STORE: slowProfile,
    });
    try {
      await ask(`When does the ${topic} warehouse open?`);
    } finally {
      await restore();
    }
    const recall = latestRecallIn(chats.provider.requests.at(-1)?.body);

    expect({
      evidence: recall.includes(`The ${topic} warehouse opens`),
      profile: recall.includes(theirs),
      marked: await chats.stub.isChatPrivateRead(chat.id),
    }).toStrictEqual({ evidence: true, profile: false, marked: false });
  });
});

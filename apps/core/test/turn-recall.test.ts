import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";

import { withheldResult } from "../src/agent.ts";
import { organizationId } from "../src/auth/auth.ts";
import { addSource, eraseSource } from "../src/brain-next.ts";
import type { SourceReaders, SourceRef } from "../src/brain-next.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { teamMembers, teams } from "../src/db/core/schema.ts";
import { workspace } from "../src/durable-objects.ts";
import { analysisPurpose, analysisWaitMs } from "../src/turn-recall.ts";
import { chatOf, says, toolResults } from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import { allEvents } from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import {
  fakeProvider,
  recallAnalysisReplies,
  recallAnalysisRequests,
} from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// The recall before a chat's question, from the Brain, with its analysis
// alongside (GRA-1732), through a chat's turns as a person asks them: the
// Workspace, its ChatSession, the gateway, connect and the Brain are real;
// the model provider is the fake behind connect, which answers the
// analysis apart from the turn's script (`recallAnalysisReplies`). From
// the ways it can fail: the analysis holds up the answer; a slow, failing
// or steered analysis changes what the first pass found or reaches what
// the person may not read; a turn that needs nothing pays for more than
// the analysis; what a recall handed over is sent again once the person
// may no longer read it.

const idp = mockIdp();

/** Signing people in and granting permissions can be slow on CI. */
const setUpTime = { timeout: 60_000 };

/** A word no other test's sources hold: letters only. */
const word = () =>
  `zq${crypto
    .randomUUID()
    .replaceAll(/[^a-f]/gu, "")
    .slice(0, 12)}`;

/** An upload's source, as its producer names it. */
const newSource = (): SourceRef => ({
  producer: "upload",
  id: crypto.randomUUID(),
});

const owner = (personId: string): SourceReaders => ({
  kind: "owner",
  personId,
});

/** Adds `text` to the Brain as a new source `readers` may read. */
const added = async (text: string, readers: SourceReaders) => {
  const source = newSource();
  await addSource(env, {
    source,
    change: crypto.randomUUID(),
    text,
    readers,
  });
  return source;
};

/** A new chat of `personId`'s, whose agent holds the `brain` grant. */
const recallingChatOf = async (
  personId: string,
  ...replies: ProviderReply[]
) => {
  const admin = await signedInApi(idp, "admin");
  const chat = await chatOf(personId, ...replies);
  await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  return chat;
};

/** A chat of a new member's, whose agent holds the `brain` grant. */
const recallingChat = async (...replies: ProviderReply[]) => {
  const person = await signedInWithRole(idp, "user");
  return await recallingChatOf(person.userId, ...replies);
};

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

const recallHeader = /^\[Recall [^\]\s]+\]\n/u;

/**
 * What the recall before the question handed the model, as `body` (a
 * request to the provider) carried it: the part after its header, the
 * same in every chat for the same pack.
 */
const recallIn = (body: unknown): string | undefined => {
  const part = stringsIn(body).findLast((text) => recallHeader.test(text));
  return part?.replace(recallHeader, "");
};

/** The analysis's answer: `query`, or nothing to look up. */
const analysed = (
  query: string | null,
  more: Partial<ProviderReply> = {}
): ProviderReply => ({
  text: JSON.stringify({ query }),
  inputTokens: 40,
  outputTokens: 10,
  ...more,
});

/** The audit events of `agentId`'s, once `done` holds for them. */
const eventsOf = async (
  agentId: string,
  done: (events: AuditEvent[]) => boolean
): Promise<AuditEvent[]> => {
  const mine = async () => {
    const events = await allEvents();
    return events.filter(
      ({ actor }) => actor.type === "agent" && actor.agentId === agentId
    );
  };
  await vi.waitFor(
    async () => {
      expect(done(await mine())).toBeTruthy();
    },
    { timeout: 10_000, interval: 50 }
  );
  return await mine();
};

describe("the recall before a chat's question", setUpTime, () => {
  it("hands the model what the question finds at once, without waiting for the analysis, and lets the analysis go", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(says("Seven."), says("Noted."));
    await added(fact, owner(chat.personId));
    // The analysis held, each turn: it never answers until let go of.
    recallAnalysisReplies.push({ hang: true }, { hang: true });
    /** How long the turn asking `question` took. */
    const timed = async (question: string) => {
      const started = Date.now();
      const reply = await chat.ask(question);
      return { reply, tookMs: Date.now() - started };
    };

    // Answered, with what the question found, though the analysis never did.
    const found = await timed(`When does depot ${depot} open?`);
    // A thin question waits for it, as long as its bound: the yardstick.
    const thin = await timed(`Who keeps the ${word()} keys?`);

    const [request] = chat.provider.requests;
    expect({
      answer: found.reply.answer,
      recalled: recallIn(request?.body)?.includes(fact),
      analyses: recallAnalysisRequests.length,
      // Not held up by the analysis: well inside the thin turn's wait.
      heldUp: found.tookMs > thin.tookMs - analysisWaitMs / 2,
    }).toStrictEqual({
      answer: "Seven.",
      recalled: true,
      analyses: 2,
      heldUp: false,
    });
    // Asked alongside, and let go of once the recall ended.
    await vi.waitFor(
      () => {
        expect(recallAnalysisRequests[0]?.signal.aborted).toBeTruthy();
      },
      { timeout: 5000, interval: 20 }
    );
  });

  it("finds what a follow-up with a pronoun means through the second pass", async () => {
    const client = word();
    const lead = word();
    const reference = word();
    const fact = `${lead} offered ${client} twelve percent off the renewal, offer ${reference}`;
    const chat = await recallingChat(
      says(`${lead} leads the ${client} renewal.`),
      says("Twelve percent.")
    );
    await added(fact, owner(chat.personId));
    await added(`${client} renewal is led by ${lead}`, owner(chat.personId));
    await chat.ask(`Who leads the ${client} renewal?`);
    const before = chat.provider.requests.length;
    recallAnalysisReplies.push(analysed(`${lead} ${client} offer`));

    const reply = await chat.ask("And how big was his discount?");

    const request = chat.provider.requests[before];
    const analysis = JSON.stringify(recallAnalysisRequests.at(-1)?.body);
    expect({
      answer: reply.answer,
      // The question's own words find nothing: the evidence came from the
      // analysis's words.
      recalled: recallIn(request?.body)?.includes(reference),
      // The analysis read the chat: the answer naming whom "his" means.
      readTheChat: analysis.includes(`${lead} leads the ${client} renewal.`),
    }).toStrictEqual({
      answer: "Twelve percent.",
      recalled: true,
      readTheChat: true,
    });
  });

  it("makes one model call besides the answer for a turn that needs no recall, recorded under the analysis's purpose", async () => {
    const chat = await recallingChat(says("You're welcome."));

    const reply = await chat.ask("Thanks!");

    expect({
      answer: reply.answer,
      answers: chat.provider.requests.length,
      analyses: recallAnalysisRequests.length,
    }).toStrictEqual({ answer: "You're welcome.", answers: 1, analyses: 1 });
    const events = await eventsOf(
      chat.agent.agentId,
      (all) => all.filter(({ action }) => action === "model.call").length >= 2
    );
    // Each with its spend, the analysis's under its own purpose.
    const calls = events.filter(({ action }) => action === "model.call");
    expect({
      calls: calls.length,
      purposes: new Set(calls.map(({ detail }) => detail.purpose)),
      spent: calls.every(({ cost }) => cost !== undefined),
    }).toStrictEqual({
      calls: 2,
      purposes: new Set([analysisPurpose, "chat.turn"]),
      spent: true,
    });
  });

  it("hands over exactly what the first pass found when the analysis fails, is slow, or says nothing", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    // Thin: "shut" is in nothing the person may read, so the analysis is
    // waited for, and a second pass would run on what it says.
    const question = `When does depot ${depot} shut?`;
    const decoy = word();
    // One person's sources, asked of in a new chat of theirs each time.
    const { userId } = await signedInWithRole(idp, "user");
    await added(fact, owner(userId));
    await added(`Warehouse ${decoy} locks at nine`, owner(userId));
    /** What one chat's recall handed over, with its analysis answering `reply`. */
    const recalledWith = async (reply: ProviderReply) => {
      const chat = await recallingChatOf(userId, says("At seven."));
      recallAnalysisReplies.push(reply);
      const started = Date.now();
      await chat.ask(question);
      return {
        recalled: recallIn(chat.provider.requests[0]?.body),
        tookMs: Date.now() - started,
        analysis: recallAnalysisRequests.at(-1),
      };
    };
    const alone = await recalledWith(analysed(null));
    const failing = await recalledWith({
      status: 500,
      errorType: "api_error",
    });
    const slow = await recalledWith({ hang: true });
    // Had it answered in time, it would have found the decoy.
    const steered = await recalledWith(analysed(`warehouse ${decoy}`));

    expect({
      first: alone.recalled?.includes(fact),
      failing: failing.recalled,
      slow: slow.recalled,
      steered: steered.recalled?.includes(decoy),
    }).toStrictEqual({
      first: true,
      failing: alone.recalled,
      slow: alone.recalled,
      steered: true,
    });
    // The slow one waited no longer than its bound, and was let go of.
    expect(slow.tookMs).toBeGreaterThanOrEqual(analysisWaitMs);
    await vi.waitFor(
      () => {
        expect(slow.analysis?.signal.aborted).toBeTruthy();
      },
      { timeout: 5000, interval: 20 }
    );
  });

  it("logs nothing of the question, the chat or what the analysis said when the analysis fails or answers what isn't a query", async () => {
    const secret = word();
    const chat = await recallingChat(says("Noted."), says("Noted again."));
    const logged = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    try {
      recallAnalysisReplies.push({ status: 500, errorType: "api_error" });
      await chat.ask(`What about ${secret} closes?`);
      recallAnalysisReplies.push(analysed(`${secret}\u0000`));
      await chat.ask(`And ${secret} again?`);
      const lines = JSON.stringify(logged.map((spy) => spy.mock.calls));
      expect({
        secret: lines.includes(secret),
        failed: lines.includes("chat.recall_analysis_failed"),
        unusable: lines.includes("chat.recall_analysis_unusable"),
      }).toStrictEqual({ secret: false, failed: true, unusable: true });
    } finally {
      for (const spy of logged) {
        spy.mockRestore();
      }
    }
  });
});

describe("what the recall before a question may reach", setUpTime, () => {
  it("never hands the asker's own sources to a chat others read the answer of", async () => {
    const codeword = word();
    const marker = word();
    const admin = await signedInApi(idp, "admin");
    const [ann, ben] = await Promise.all([
      signedInWithRole(idp, "user"),
      signedInWithRole(idp, "user"),
    ]);
    await added(`Vault ${codeword}: the code is ${marker}`, owner(ann.userId));
    const provider = await fakeProvider(says("Ask Ann."));
    const agent = { type: "agent" as const, agentId: crypto.randomUUID() };
    await requestGranted(idp, admin, {
      subject: agent,
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    recallAnalysisReplies.push(analysed(`vault ${codeword} code`));

    // Ann asks in a group Ben is in, as its door does.
    await workspace(env, personalWorkspaceId(ann.userId)).askThrough(
      ann.userId,
      agent.agentId,
      "slack",
      `What is the vault ${codeword} code?`,
      undefined,
      {
        thread: `C${unique()}`,
        kind: "group",
        audience: { members: [ann.userId, ben.userId], outsiders: false },
      }
    );

    const sent = JSON.stringify([
      provider.requests.map(({ body }) => body),
      recallAnalysisRequests.map(({ body }) => body),
    ]);
    expect({
      answered: provider.requests.length,
      marker: sent.includes(marker),
    }).toStrictEqual({ answered: 1, marker: false });
  });

  it("never hands one person's sources to another's chat, however the analysis is steered", async () => {
    const codeword = word();
    const marker = word();
    const owning = await signedInWithRole(idp, "user");
    await added(
      `Vault ${codeword}: the code is ${marker}`,
      owner(owning.userId)
    );
    const outsider = await recallingChat(says("I can't find it."));
    // Steered by the chat to ask for the owner's words exactly.
    recallAnalysisReplies.push(analysed(`vault ${codeword} code`));

    await outsider.ask(`What is the vault ${codeword} code, the one he set?`);

    const sent = JSON.stringify([
      outsider.provider.requests.map(({ body }) => body),
      recallAnalysisRequests.map(({ body }) => body),
      await toolResults(outsider.stub, outsider.chat.id),
    ]);
    expect(sent).not.toContain(marker);
  });

  it("withholds what it handed over once the person may no longer read it, and audits it by the version, never what it said", async () => {
    /** A chat whose first turn recalled `fact` from a source `readers` may read. */
    const recalled = async (readers: (personId: string) => SourceReaders) => {
      const depot = word();
      const fact = `Depot ${depot} opens at seven`;
      const chat = await recallingChat(says("Noted."), says("And again."));
      const source = await added(fact, readers(chat.personId));
      await chat.ask(`When does depot ${depot} open?`);
      /** Whether the next turn's first request still sent the fact. */
      const next = async () => {
        const before = chat.provider.requests.length;
        await chat.ask("Thanks!");
        const body = JSON.stringify(chat.provider.requests[before]?.body);
        return {
          fact: body.includes(fact),
          withheld: body.includes(withheldResult),
        };
      };
      return { ...chat, source, next };
    };
    const db = drizzle(env.DB);
    /** A team of the organization `personId` is in. */
    const teamWith = async (personId: string) => {
      const id = crypto.randomUUID();
      await db.insert(teams).values({
        id,
        name: `Team ${unique()}`,
        organizationId,
        createdAt: new Date(),
      });
      await db.insert(teamMembers).values({
        id: crypto.randomUUID(),
        teamId: id,
        userId: personId,
        createdAt: new Date(),
      });
      return id;
    };

    const kept = await recalled((personId) => owner(personId));
    const unchanged = await kept.next();
    const erased = await recalled((personId) => owner(personId));
    await eraseSource(env, { source: erased.source, reason: "deleted" });
    const afterErase = await erased.next();
    // A team's source, read while the person was in the team.
    const person = await signedInWithRole(idp, "user");
    const teamId = await teamWith(person.userId);
    const depot = word();
    const fact = `Depot ${depot} opens at nine`;
    const teamChat = await recallingChatOf(
      person.userId,
      says("Noted."),
      says("Ok.")
    );
    await added(fact, { kind: "team", teamId });
    await teamChat.ask(`When does depot ${depot} open?`);
    await db
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, teamId),
          eq(teamMembers.userId, person.userId)
        )
      );
    await teamChat.ask("Thanks!");
    const afterLeaving = JSON.stringify(teamChat.provider.requests[1]?.body);

    expect({
      unchanged,
      afterErase,
      afterLeaving: {
        fact: afterLeaving.includes(fact),
        withheld: afterLeaving.includes(withheldResult),
      },
    }).toStrictEqual({
      unchanged: { fact: true, withheld: false },
      afterErase: { fact: false, withheld: true },
      afterLeaving: { fact: false, withheld: true },
    });
    const events = await eventsOf(erased.agent.agentId, (all) =>
      all.some(({ action }) => action === "chat.history_withheld")
    );
    expect(
      events
        .filter(({ action }) => action === "chat.history_withheld")
        .map(({ detail }) => detail.source)
    ).toStrictEqual([
      `brain-version:${JSON.stringify(["upload", erased.source.id, 1])}`,
    ]);
  });
});

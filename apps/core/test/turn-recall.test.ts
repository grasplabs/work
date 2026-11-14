import { brainOf, personalBrainOf } from "@grasp-os/brain-next/contract";
import type { AuditEvent } from "@grasp-os/shared/audit";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";

import { withheldResult } from "../src/agent.ts";
import { organizationId } from "../src/auth/auth.ts";
import {
  addSource,
  eraseSource,
  forgetAs,
  mergeRecalled,
  recallAs,
  recalledTokens,
  rememberAs,
} from "../src/brain-next.ts";
import type {
  RecalledItem,
  RecalledMemory,
  RecalledPack,
  SourceReaders,
  SourceRef,
} from "../src/brain-next.ts";
import { personalWorkspaceId } from "../src/chats-rpc.ts";
import { chatAudiences, teamMembers, teams } from "../src/db/core/schema.ts";
import { inJurisdiction, workspace } from "../src/durable-objects.ts";
import {
  analysisPurpose,
  recallTimeoutReason,
  turnRecallMethod,
} from "../src/turn-recall.ts";
import type { ChatPlace } from "../src/workspace.ts";
import {
  chatOf,
  codeStep,
  model,
  says,
  setObjectEnv,
  toolResults,
  toolStep,
} from "./agent-chat.ts";
import { requestGranted } from "./apps.ts";
import {
  allEvents,
  eventsAfter,
  logHead,
  loggedEvents,
} from "./audit-events.ts";
import { mockIdp } from "./idp.ts";
import { answeringProvider, fakeProvider } from "./model-provider.ts";
import type { ProviderReply } from "./model-provider.ts";
import { outcome, signedInApi, signedInWithRole, unique } from "./sign-in.ts";

// The recall before a chat's question, from the Brain, with its analysis
// alongside (GRA-1732), through a chat's turns as a person asks them: the
// Workspace, its ChatSession, the gateway, connect and the Brain are real;
// the model provider is the fake behind connect, which answers the
// analysis apart from the turn's script (`analysisReplies`). From the
// ways it can fail: the analysis holds up the answer; a slow, failing or
// steered analysis changes what the first pass found or reaches what the
// person may not read; a turn that needs nothing pays for more than the
// analysis; the model gets what the audit log doesn't hold, or the log
// holds what didn't happen; what a recall handed over is sent again once
// the person may no longer read it, or the agent its grant.

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

/**
 * Adds `text` as a source everyone in the company may read, to the shared
 * store as a producer would: core's producers add none yet. Every test's
 * person reads it, so its text holds only words no other test asks for.
 */
const forEveryone = async (text: string): Promise<SourceRef> => {
  const source = newSource();
  await brainOf(inJurisdiction(env, env.BRAIN_STORE)).addSource({
    source: `upload:${source.id}`,
    change: crypto.randomUUID(),
    text,
    access: { kind: "audience", group: "company" },
  });
  return source;
};

/** What happens to a recalled source: nothing. */
const leftAlone = async () => {
  // Nothing changes: what was recalled stays in the chat's history.
};
/** A new version only a team may read: the person's own team even. */
const narrowedToTeam = async (
  source: SourceRef,
  depot: string,
  teamId: string
) => {
  await brainOf(inJurisdiction(env, env.BRAIN_STORE)).addSource({
    source: `upload:${source.id}`,
    change: crypto.randomUUID(),
    text: `${depot} now only for the team.`,
    access: { kind: "audience", group: `team:${teamId}` },
  });
};
/** The source erased. */
const erasedWhole = async (
  source: SourceRef,
  _depot: string,
  teamId: string
) => {
  await eraseSource(env, {
    source,
    readers: { kind: "team", teamId },
    reason: "deleted",
  });
};

/**
 * The roster kept for chat `chatId` gone while the chat keeps what it
 * recalled: as core's database restored to before it was kept leaves it.
 */
const dropRoster = async (chatId: string) => {
  await drizzle(env.DB)
    .delete(chatAudiences)
    .where(eq(chatAudiences.chatId, chatId));
};

/** A new team of `personId`'s: its readers, and its group as the Brain names it. */
const teamOf = async (
  personId: string
): Promise<{ readers: SourceReaders; group: string; teamId: string }> => {
  const teamId = crypto.randomUUID();
  const db = drizzle(env.DB);
  await db.insert(teams).values({
    id: teamId,
    name: `Team ${unique()}`,
    organizationId,
    createdAt: new Date(),
  });
  await db.insert(teamMembers).values({
    id: crypto.randomUUID(),
    teamId,
    userId: personId,
    createdAt: new Date(),
  });
  return {
    readers: { kind: "team", teamId },
    group: `team:${teamId}`,
    teamId,
  };
};

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

/**
 * A new chat of `personId`'s, whose agent holds the `brain` grant, and
 * `revoke`, which revokes it.
 */
const recallingChatOf = async (
  personId: string,
  ...replies: ProviderReply[]
) => {
  const admin = await signedInApi(idp, "admin");
  const chat = await chatOf(personId, ...replies);
  const grant = await requestGranted(idp, admin, {
    subject: chat.agent,
    object: { type: "platform" },
    actions: ["brain"],
    binding: "BRAIN",
  });
  const revoke = async () => {
    await admin.api.permissions.revoke(grant);
  };
  return { ...chat, revoke };
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

const recallHeader = /^\[Recall (?<run>[^\]\s]+)\]\n/u;

/**
 * What the recall before the question handed the model, as `body` (a
 * request to the provider) carried it: the part after its header, the
 * same in every chat for the same pack.
 */
const recallIn = (body: unknown): string | undefined => {
  const part = stringsIn(body).findLast((text) => recallHeader.test(text));
  return part?.replace(recallHeader, "");
};

/** The run of the recall `body` (a request to the provider) carried. */
const recallRunIn = (body: unknown): string | undefined => {
  const part = stringsIn(body).findLast((text) => recallHeader.test(text));
  return part === undefined ? undefined : recallHeader.exec(part)?.groups?.run;
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

/** The audit events of the recall before a question in chat `chatId`. */
const recallsIn = (events: readonly AuditEvent[], chatId: string) =>
  events.filter(
    ({ action, detail }) =>
      action === "agent.call" &&
      detail.method === turnRecallMethod &&
      detail.chat === chatId
  );

/** The `chat.history_withheld` events of chat `chatId` in `events`. */
const withheldIn = (events: readonly AuditEvent[], chatId: string) =>
  events.filter(
    ({ action, target }) =>
      action === "chat.history_withheld" && target?.id === chatId
  );

/**
 * The detail a withheld event gives for everything the first recall of
 * chat `chatId` in `events` handed over, withheld whole by one cause
 * (`withheldDetail`): its versions as passages and its memories, of one
 * run newly withheld, and `more`.
 */
const allRecalledWithheld = (
  events: readonly AuditEvent[],
  chatId: string,
  workspaceName: string,
  more: Record<string, unknown> = {}
) => {
  const [recall] = recallsIn(events, chatId);
  const passages = Number(recall?.detail.versions);
  const memories = Number(recall?.detail.memories);
  return {
    workspace: workspaceName,
    runs: 1,
    sources: passages + memories,
    ...(passages > 0 ? { passages } : {}),
    ...(memories > 0 ? { memories } : {}),
    ...more,
  };
};

/** How each recall event of run `run` in `events` says it ended, in order. */
const outcomesOf = (events: readonly AuditEvent[], run: string | undefined) =>
  events
    .filter(
      ({ action, detail }) =>
        action === "agent.call" &&
        detail.method === turnRecallMethod &&
        detail.run === run
    )
    .map(({ detail }) => ({ outcome: detail.outcome, reason: detail.reason }));

/** Whether a warning named `name` was logged in `calls`, the spy's calls. */
const warned = (calls: readonly unknown[], name: string): boolean =>
  JSON.stringify(calls).includes(name);

type Call = (...args: unknown[]) => Promise<unknown>;

/**
 * `namespace` (a Durable Object binding) with each object's `method`
 * answered by `instead`, given the object's own: a fault where the chat
 * meets one of core's objects, as `failingAuditLog` puts one.
 */
const answering = (
  namespace: object,
  method: string,
  instead: (own: Call, ...args: unknown[]) => Promise<unknown>
): object =>
  new Proxy(namespace, {
    get: (target, name): unknown => {
      const value: unknown = Reflect.get(target, name);
      if (typeof value !== "function") {
        return value;
      }
      if (name === "jurisdiction") {
        return (...args: unknown[]): object =>
          answering(
            // SAFETY: a namespace's `jurisdiction` answers a namespace.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see SAFETY
            Reflect.apply(value, target, args) as object,
            method,
            instead
          );
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
            if (property !== method || typeof own !== "function") {
              return own;
            }
            return async (...called: unknown[]) =>
              await instead(
                async (...again: unknown[]): Promise<unknown> =>
                  await Reflect.apply(own, object, again),
                ...called
              );
          },
        });
      };
    },
  });

/** Runs `work` with the shared env's `vars` set, then puts them back. */
const withEnv = async <T>(
  chat: { stub: Parameters<typeof setObjectEnv>[0] },
  vars: Record<string, unknown>,
  work: () => Promise<T>
): Promise<T> => {
  const restore = await setObjectEnv(chat.stub, vars);
  try {
    return await work();
  } finally {
    await restore();
  }
};

/** Whether `events`, an append's, hold a recall's `ok`. */
const holdsRecalled = (events: unknown): boolean =>
  Array.isArray(events) &&
  events.some(
    (event: AuditEvent) =>
      event.action === "agent.call" &&
      event.detail.method === turnRecallMethod &&
      event.detail.outcome === "ok"
  );

describe("the recall before a chat's question", setUpTime, () => {
  it("hands the model what the question finds without waiting for the analysis, a word nothing holds beside it too, asks none for a first message, and lets the analysis go", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(
      says("Nobody I know of."),
      says("Seven."),
      says("Still seven."),
      says("No idea.")
    );
    await added(fact, owner(chat.personId));
    // The analysis held, each turn: it never answers until let go of.
    chat.provider.analysisReplies.push(
      { hang: true },
      { hang: true },
      { hang: true }
    );
    const warnings = vi.spyOn(console, "warn");
    /** What asking `question` handed over, and whether it waited on the analysis. */
    const asked = async (question: string) => {
      const before = {
        requests: chat.provider.requests.length,
        analyses: chat.provider.analyses.length,
        warnings: warnings.mock.calls.length,
      };
      await chat.ask(question);
      return {
        recalled:
          recallIn(chat.provider.requests[before.requests]?.body)?.includes(
            fact
          ) ?? false,
        analysed: chat.provider.analyses.length > before.analyses,
        // Waited on and given up on: logged as late.
        waited: warned(
          warnings.mock.calls.slice(before.warnings),
          "chat.recall_analysis_late"
        ),
      };
    };
    try {
      // Finds nothing, but has nothing before it to resolve.
      const opening = await asked(`Who keeps the ${word()} keys?`);
      const found = await asked(`When does depot ${depot} open?`);
      const besideUnknown = await asked(
        `When does depot ${depot} open on ${word()} days?`
      );
      // The contrast: a follow-up that finds nothing waits, to its bound.
      const thin = await asked(`Who keeps the ${word()} keys?`);

      expect({ opening, found, besideUnknown, thin }).toStrictEqual({
        opening: { recalled: false, analysed: false, waited: false },
        found: { recalled: true, analysed: true, waited: false },
        besideUnknown: { recalled: true, analysed: true, waited: false },
        thin: { recalled: false, analysed: true, waited: true },
      });
    } finally {
      warnings.mockRestore();
    }
    // Asked alongside, and let go of once each recall ended.
    await vi.waitFor(
      () => {
        expect(
          chat.provider.analyses.every(({ signal }) => signal.aborted)
        ).toBeTruthy();
      },
      { timeout: 5000, interval: 20 }
    );
  });

  it("searches as much of a long question as the Brain takes: an ID past its first 500 characters is found", async () => {
    const invoice = word();
    const chat = await recallingChat(says("Paid."));
    await added(`Invoice ${invoice} was paid on 3 March`, owner(chat.personId));
    const padding = "Some context about our month end close. ".repeat(14);

    await chat.ask(`${padding}What is the status of invoice ${invoice}?`);

    expect({
      past500: padding.length > 500,
      found: recallIn(chat.provider.requests[0]?.body)?.includes(invoice),
    }).toStrictEqual({ past500: true, found: true });
  });

  it("records the recall in the audit log, with its run and how many versions it hands over and never what they say, before the model gets any of it", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat();
    await added(fact, owner(chat.personId));
    // The log as it stood when the model was first asked, straight from
    // it: what an outbox still holds isn't in it.
    let logged: Promise<AuditEvent[]> | undefined;
    const provider = await answeringProvider(() => {
      logged ??= loggedEvents();
      return says("Seven.");
    });

    await chat.ask(`When does depot ${depot} open?`);

    const recalls = recallsIn((await logged) ?? [], chat.chat.id);
    expect({
      recalls: recalls.map(({ detail }) => ({
        versions: detail.versions,
        run: detail.run,
        reads: detail.reads,
        outcome: detail.outcome,
      })),
      saysWhat: JSON.stringify(recalls).includes(depot),
    }).toStrictEqual({
      recalls: [
        {
          versions: 1,
          run: recallRunIn(provider.requests[0]?.body),
          // Her own chat: as her, her own store too; no count of people.
          reads: "person",
          outcome: "ok",
        },
      ],
      saysWhat: false,
    });
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
    // Case and edges aside, not the question's own words: a second pass.
    chat.provider.analysisReplies.push(analysed(` ${lead} ${client} OFFER `));

    const reply = await chat.ask("And how big was his discount?");

    const request = chat.provider.requests[before];
    const analysis = JSON.stringify(chat.provider.analyses.at(-1)?.body);
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

  it("makes one model call besides the answer for a follow-up that needs no recall, recorded under the analysis's purpose", async () => {
    const chat = await recallingChat(says("Hello."), says("You're welcome."));
    await chat.ask("Hi!");

    const reply = await chat.ask("Thanks!");

    expect({
      answer: reply.answer,
      answers: chat.provider.requests.length,
      // The first message asked none: nothing before it.
      analyses: chat.provider.analyses.length,
    }).toStrictEqual({ answer: "You're welcome.", answers: 2, analyses: 1 });
    const events = await eventsOf(
      chat.agent.agentId,
      (all) => all.filter(({ action }) => action === "model.call").length >= 3
    );
    // Each with its spend, the analysis's under its own purpose.
    const calls = events.filter(({ action }) => action === "model.call");
    expect({
      calls: calls.length,
      purposes: new Set(calls.map(({ detail }) => detail.purpose)),
      spent: calls.every(({ cost }) => cost !== undefined),
    }).toStrictEqual({
      calls: 3,
      purposes: new Set([analysisPurpose, "chat.turn"]),
      spent: true,
    });
  });

  it("hands over exactly what the first pass found when the analysis fails, is slow, or says nothing", async () => {
    const decoy = word();
    // Thin: none of its words is in anything the person may read, so the
    // analysis is waited for, and a second pass would run on what it says.
    const question = "When does that one shut?";
    // One person's sources, asked of in a new chat of theirs each time.
    const { userId } = await signedInWithRole(idp, "user");
    await added(`Warehouse ${decoy} locks at nine`, owner(userId));
    /** What one chat's recall handed over, with its analysis answering `reply`. */
    const recalledWith = async (reply: ProviderReply) => {
      const chat = await recallingChatOf(
        userId,
        says("Hello."),
        says("At nine.")
      );
      // Something before the question, for the analysis to read.
      await chat.ask("Hi!");
      chat.provider.analysisReplies.push(reply);
      await chat.ask(question);
      return {
        recalled: recallIn(chat.provider.requests[1]?.body),
        analysis: chat.provider.analyses.at(-1),
      };
    };
    const alone = await recalledWith(analysed(null));
    const failing = await recalledWith({
      status: 500,
      errorType: "api_error",
    });
    const slow = await recalledWith({ hang: true });
    // Had the others answered in time with words, they would have found it.
    const steered = await recalledWith(analysed(`warehouse ${decoy}`));
    // Half a pair in its words: mended, not refused by the Brain.
    const malformed = await recalledWith(analysed(`warehouse ${decoy} \uD800`));
    // Longer than the Brain takes: cut as a question is, not dropped.
    const overlong = await recalledWith(
      analysed(`warehouse ${decoy} ${"and more ".repeat(300)}`)
    );

    expect({
      first: alone.recalled?.includes(decoy),
      failing: failing.recalled,
      slow: slow.recalled,
      steered: steered.recalled?.includes(decoy),
      malformed: malformed.recalled?.includes(decoy),
      overlong: overlong.recalled?.includes(decoy),
    }).toStrictEqual({
      first: false,
      failing: alone.recalled,
      slow: alone.recalled,
      steered: true,
      malformed: true,
      overlong: true,
    });
    // The slow one was let go of.
    await vi.waitFor(
      () => {
        expect(slow.analysis?.signal.aborted).toBeTruthy();
      },
      { timeout: 5000, interval: 20 }
    );
  });

  it("logs nothing of the question, the chat or what the analysis said when the analysis fails or answers what isn't a query", async () => {
    const secret = word();
    const chat = await recallingChat(
      says("Hello."),
      says("Noted."),
      says("Noted again.")
    );
    await chat.ask("Hi!");
    const logged = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    try {
      chat.provider.analysisReplies.push({
        status: 500,
        errorType: "api_error",
      });
      await chat.ask(`What about ${secret} closes?`);
      chat.provider.analysisReplies.push(analysed(`${secret}\u0000`));
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

describe("a recall before a question that doesn't hand over", setUpTime, () => {
  it("answers without evidence, told why, when the Brain refuses the recall or it runs past its deadline, and logs how it ended for its run", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(says("I can't say."), says("Nor now."));
    await added(fact, owner(chat.personId));
    /** What the model got, with the Brain's stores finding passages as `recall` does. */
    const askedWith = async (recall: Call) => {
      const before = chat.provider.requests.length;
      await withEnv(
        chat,
        {
          // A person's own chat recalls from both stores (`find`).
          BRAIN_STORE: answering(
            env.BRAIN_STORE,
            "find",
            async () => await recall()
          ),
        },
        async () => await chat.ask(`When does depot ${depot} open?`)
      );
      const body = chat.provider.requests[before]?.body;
      return { recalled: recallIn(body) ?? "", run: recallRunIn(body) };
    };

    const refused = await askedWith(
      async () => await Promise.reject(new Error("The Brain refused it"))
    );
    // Past the recall's deadline: it never answers.
    const late = await askedWith(
      async () => await Promise.withResolvers<never>().promise
    );

    const events = await eventsOf(
      chat.agent.agentId,
      (all) => recallsIn(all, chat.chat.id).length >= 2
    );
    expect({
      refused: {
        fact: refused.recalled.includes(fact),
        told: refused.recalled.includes("The recall failed."),
        logged: outcomesOf(events, refused.run),
      },
      late: {
        fact: late.recalled.includes(fact),
        told: late.recalled.includes("The recall took too long."),
        logged: outcomesOf(events, late.run),
      },
    }).toStrictEqual({
      refused: {
        fact: false,
        told: true,
        logged: [{ outcome: "failed", reason: "internal.unexpected" }],
      },
      late: {
        fact: false,
        told: true,
        logged: [{ outcome: "failed", reason: recallTimeoutReason }],
      },
    });
  });

  it("hands over nothing when the audit log doesn't take the recall, and logs it as failed for its run", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(says("I can't say."));
    await added(fact, owner(chat.personId));

    await withEnv(
      chat,
      {
        AUDIT_LOG: answering(env.AUDIT_LOG, "append", async (own, events) => {
          if (holdsRecalled(events)) {
            throw new Error("Unavailable");
          }
          return await own(events);
        }),
      },
      async () => await chat.ask(`When does depot ${depot} open?`)
    );

    const body = chat.provider.requests[0]?.body;
    const events = await eventsOf(
      chat.agent.agentId,
      (all) => recallsIn(all, chat.chat.id).length > 0
    );
    expect({
      fact: recallIn(body)?.includes(fact),
      told: recallIn(body)?.includes("The recall failed."),
      logged: outcomesOf(events, recallRunIn(body)),
    }).toStrictEqual({
      fact: false,
      told: true,
      logged: [{ outcome: "failed", reason: "internal.unexpected" }],
    });
  });

  it("goes on without the evidence, told it took too long, when the audit log doesn't answer within the recall's time, and never hands it over later", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(says("I can't say."), says("Noted."));
    await added(fact, owner(chat.personId));

    // A log that never answers the recall's event.
    await withEnv(
      chat,
      {
        AUDIT_LOG: answering(env.AUDIT_LOG, "append", async (own, events) =>
          holdsRecalled(events)
            ? await Promise.withResolvers<never>().promise
            : await own(events)
        ),
      },
      async () => await chat.ask(`When does depot ${depot} open?`)
    );
    await chat.ask("Thanks!");

    const [asked, next] = chat.provider.requests.map(({ body }) => body);
    const events = await eventsOf(
      chat.agent.agentId,
      (all) => recallsIn(all, chat.chat.id).length > 0
    );
    expect({
      fact: recallIn(asked)?.includes(fact),
      told: recallIn(asked)?.includes("The recall took too long."),
      later: JSON.stringify(next).includes(fact),
      logged: outcomesOf(events, recallRunIn(asked)),
    }).toStrictEqual({
      fact: false,
      told: true,
      later: false,
      logged: [{ outcome: "failed", reason: recallTimeoutReason }],
    });
  });

  it("lets go of the analysis as soon as a sufficient first pass ends, before its reads are recorded, and searches no rewrite", async () => {
    const depot = word();
    const decoy = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(
      says("Hello."),
      says("Seven."),
      says("Still seven.")
    );
    await added(fact, owner(chat.personId));
    await added(`Warehouse ${decoy} locks at nine`, owner(chat.personId));
    await chat.ask("Hi!");
    // Held: it answers only once let go of.
    chat.provider.analysisReplies.push({ hang: true });
    // The log holds the recall's event until the test saw the analysis go:
    // flags, as what one object resolves the test can't go on from.
    const step = { reached: false, released: false };

    await withEnv(
      chat,
      {
        AUDIT_LOG: answering(env.AUDIT_LOG, "append", async (own, events) => {
          if (holdsRecalled(events)) {
            step.reached = true;
            for (let waits = 0; !step.released && waits < 500; waits += 1) {
              // oxlint-disable-next-line no-await-in-loop -- until the test saw it
              await scheduler.wait(20);
            }
          }
          return await own(events);
        }),
      },
      async () => {
        const asked = chat.ask(`When does depot ${depot} open?`).then(
          () => "answered",
          (error: unknown) => (error instanceof Error ? error.message : "")
        );
        await vi.waitFor(
          () => {
            expect(step.reached).toBeTruthy();
          },
          { timeout: 10_000, interval: 20 }
        );
        // While the recall's event is still on its way to the log.
        await vi.waitFor(
          () => {
            expect(chat.provider.analyses[0]?.signal.aborted).toBeTruthy();
          },
          { timeout: 5000, interval: 20 }
        );
        step.released = true;
        return await asked;
      }
    );
    // Answered at once with words of its own: not searched.
    chat.provider.analysisReplies.push(analysed(`warehouse ${decoy}`));
    await chat.ask(`And when does depot ${depot} open on Sundays?`);

    expect({
      first: recallIn(chat.provider.requests[1]?.body)?.includes(fact),
      rewrite: recallIn(chat.provider.requests[2]?.body)?.includes(decoy),
      found: recallIn(chat.provider.requests[2]?.body)?.includes(fact),
    }).toStrictEqual({ first: true, rewrite: false, found: true });
  });

  it("logs a recall revoked after it was recorded and before it was handed over as failed for its run, and the turn stops with nothing handed over", async () => {
    const depot = word();
    const fact = `Depot ${depot} opens at seven`;
    const chat = await recallingChat(says("I can't say."));
    await added(fact, owner(chat.personId));

    // The grant revoked once the recall's `ok` is on its way to the log,
    // by the test, while the log waits: flags, not promises, as what one
    // object resolves the test can't go on from (its I/O is the object's).
    const step = { reached: false, revoked: false };
    const ended = await withEnv(
      chat,
      {
        AUDIT_LOG: answering(env.AUDIT_LOG, "append", async (own, events) => {
          if (holdsRecalled(events)) {
            step.reached = true;
            for (let waits = 0; !step.revoked && waits < 500; waits += 1) {
              // oxlint-disable-next-line no-await-in-loop -- until the test revoked
              await scheduler.wait(20);
            }
          }
          return await own(events);
        }),
      },
      async () => {
        // Settled here, either way: a rejection is never left unhandled.
        const asked = chat.ask(`When does depot ${depot} open?`).then(
          () => "answered",
          (error: unknown) => (error instanceof Error ? error.message : "")
        );
        await vi.waitFor(
          () => {
            expect(step.reached).toBeTruthy();
          },
          { timeout: 10_000, interval: 20 }
        );
        await chat.revoke();
        step.revoked = true;
        return await asked;
      }
    );

    const events = await eventsOf(
      chat.agent.agentId,
      (all) => recallsIn(all, chat.chat.id).length >= 2
    );
    const runs = new Set(
      recallsIn(events, chat.chat.id).map(({ detail }) => detail.run)
    );
    const [run] = runs;
    expect({
      stopped: ended.includes("can no longer read"),
      runs: runs.size,
      asked: chat.provider.requests.length,
      logged: outcomesOf(events, typeof run === "string" ? run : undefined),
    }).toStrictEqual({
      stopped: true,
      runs: 1,
      // Nothing of it reached the model: the turn stopped first.
      asked: 0,
      logged: [
        { outcome: "ok", reason: null },
        { outcome: "failed", reason: "agent.run_revoked" },
      ],
    });
  });
});

describe("what the recall before a question may reach", setUpTime, () => {
  it("reads as the person only in their own chat in Grasp, in a turn they started, and as the company alone everywhere else", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const depot = word();
    const ownMarker = word();
    const teamMarker = word();
    const companyMarker = word();
    const teamId = crypto.randomUUID();
    const db = drizzle(env.DB);
    await db.insert(teams).values({
      id: teamId,
      name: `Team ${unique()}`,
      organizationId,
      createdAt: new Date(),
    });
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId,
      userId: person.userId,
      createdAt: new Date(),
    });
    // The person's alone, in their own store; their team's, in the shared one.
    await added(
      `Depot ${depot} keeps the person's own note ${ownMarker}`,
      owner(person.userId)
    );
    await added(`Depot ${depot} opens at ${teamMarker}`, {
      kind: "team",
      teamId,
    });
    await forEveryone(`${depot} ${companyMarker}`);
    const question = `What about depot ${depot}?`;
    /** What of each source reached the model, in `bodies`. */
    const of = (bodies: string) => ({
      own: bodies.includes(ownMarker),
      team: bodies.includes(teamMarker),
      company: bodies.includes(companyMarker),
    });
    const granted = async (agentId: string) => {
      await requestGranted(idp, admin, {
        subject: { type: "agent", agentId },
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      });
    };
    /** What the model was sent of each source, the turn asked through `ask`. */
    const sent = async (
      ask: (agentId: string) => Promise<unknown>,
      agentId = crypto.randomUUID()
    ) => {
      await granted(agentId);
      const provider = await fakeProvider(says("Noted."));
      await ask(agentId);
      return of(JSON.stringify(provider.requests.map(({ body }) => body)));
    };
    const through =
      (platform: string, shared?: boolean) => async (agentId: string) =>
        await workspace(env, personalWorkspaceId(person.userId)).askThrough(
          person.userId,
          agentId,
          platform,
          question,
          undefined,
          shared === true
            ? {
                thread: `C${unique()}`,
                kind: "group",
                audience: { members: [person.userId], outsiders: false },
              }
            : { kind: "direct" }
        );

    const ownChat = await recallingChatOf(person.userId, says("Noted."));
    await ownChat.ask(question);
    const web = JSON.stringify(
      ownChat.provider.requests.map(({ body }) => body)
    );
    const woken = await recallingChatOf(person.userId, says("Noted."));
    await woken.stub.askUnattended(woken.chat.id, { text: question, model });
    const unattended = JSON.stringify(
      woken.provider.requests.map(({ body }) => body)
    );
    const slack = await sent(through("slack"));
    const teamsChat = await sent(through("teams"));
    const thread = await sent(through("slack", true));

    const companyOnly = { own: false, team: false, company: true };
    expect({
      web: of(web),
      unattended: of(unattended),
      slack,
      teams: teamsChat,
      thread,
    }).toStrictEqual({
      // Theirs alone to read: their own, their team's and the company's.
      web: { own: true, team: true, company: true },
      // Not started by them: what the whole company may read alone.
      unattended: companyOnly,
      // Kept by the chat app too, whoever reads it later: the company's.
      slack: companyOnly,
      teams: companyOnly,
      // Read by others (here only the person is on its roster): the
      // company's, never their team's or their own.
      thread: companyOnly,
    });
  });

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
    provider.analysisReplies.push(analysed(`vault ${codeword} code`));

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
      provider.analyses.map(({ body }) => body),
    ]);
    expect({
      answered: provider.requests.length,
      marker: sent.includes(marker),
    }).toStrictEqual({ answered: 1, marker: false });
  });

  it("reads as the turn's place for what the chat's own search and code recall too: their teams only in their own chat in Grasp, the company alone elsewhere", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const teamId = crypto.randomUUID();
    const db = drizzle(env.DB);
    await db.insert(teams).values({
      id: teamId,
      name: `Team ${unique()}`,
      organizationId,
      createdAt: new Date(),
    });
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId,
      userId: person.userId,
      createdAt: new Date(),
    });
    // A question the recall before it finds nothing for: what reaches the
    // model of a depot is the code's or the tool's.
    const question = "Please look that up.";
    /**
     * A depot of its own for one probe, held by the person's own source,
     * their team's and the company's, and the turn's model steps: code
     * that recalls it (`env.brain.recall`), or the `searchBrain` tool.
     */
    const probeOf = async (way: "code" | "tool") => {
      const depot = word();
      const markers = { own: word(), team: word(), company: word() };
      await added(`Depot ${depot} own ${markers.own}`, owner(person.userId));
      await added(`Depot ${depot} team ${markers.team}`, {
        kind: "team",
        teamId,
      });
      await forEveryone(`${depot} ${markers.company}`);
      const asked = { question: `depot ${depot}`, budget: { tokens: 800 } };
      const step =
        way === "code"
          ? codeStep(
              `export default async (self, env) => { const pack = await env.brain.recall(${JSON.stringify(asked)}); return pack.items.map(({ text }) => text).join(" | "); };`
            )
          : toolStep("searchBrain", { question: asked.question });
      /** Which sources reached the model, in `bodies`. */
      const found = (bodies: unknown[]) => {
        const sent = JSON.stringify(bodies);
        return {
          own: sent.includes(markers.own),
          team: sent.includes(markers.team),
          company: sent.includes(markers.company),
        };
      };
      return { steps: [step, says("Noted.")], found };
    };
    const granted = async (agentId: string) => {
      await requestGranted(idp, admin, {
        subject: { type: "agent", agentId },
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      });
    };
    /** Asked in the person's own web chat, by them or by an event. */
    const inWeb = async (way: "code" | "tool", unattended: boolean) => {
      const { steps, found } = await probeOf(way);
      const chat = await recallingChatOf(person.userId, ...steps);
      await (unattended
        ? chat.stub.askUnattended(chat.chat.id, { text: question, model })
        : chat.ask(question));
      return found(chat.provider.requests.map(({ body }) => body));
    };
    /** Asked through a chat app, in a direct message or a shared thread. */
    const inApp = async (
      way: "code" | "tool",
      platform: string,
      shared: boolean
    ) => {
      const { steps, found } = await probeOf(way);
      const agentId = crypto.randomUUID();
      await granted(agentId);
      const provider = await fakeProvider(...steps);
      await workspace(env, personalWorkspaceId(person.userId)).askThrough(
        person.userId,
        agentId,
        platform,
        question,
        undefined,
        shared
          ? {
              thread: `C${unique()}`,
              kind: "group",
              audience: { members: [person.userId], outsiders: false },
            }
          : { kind: "direct" }
      );
      return found(provider.requests.map(({ body }) => body));
    };
    const each = async (way: "code" | "tool") => ({
      web: await inWeb(way, false),
      unattended: await inWeb(way, true),
      slack: await inApp(way, "slack", false),
      teams: await inApp(way, "teams", false),
      thread: await inApp(way, "slack", true),
    });

    const companyOnly = { own: false, team: false, company: true };
    const expected = {
      // Their own chat, asked there and then: their teams' and the
      // company's, never their own store (code never reads it).
      web: { own: false, team: true, company: true },
      unattended: companyOnly,
      slack: companyOnly,
      teams: companyOnly,
      // A thread others share offers no brain to the code at all.
      thread: { own: false, team: false, company: false },
    };
    expect({
      code: await each("code"),
      tool: await each("tool"),
    }).toStrictEqual({ code: expected, tool: expected });
  });

  it("recalls in a chat others share only what the company may read, nothing with anyone unnamed in it, nor in a turn nobody started there", async () => {
    const depot = word();
    const teamMarker = word();
    const companyMarker = word();
    const admin = await signedInApi(idp, "admin");
    const [ann, ben] = await Promise.all([
      signedInWithRole(idp, "user"),
      signedInWithRole(idp, "user"),
    ]);
    const teamId = crypto.randomUUID();
    const db = drizzle(env.DB);
    await db.insert(teams).values({
      id: teamId,
      name: `Team ${unique()}`,
      organizationId,
      createdAt: new Date(),
    });
    await db.insert(teamMembers).values(
      [ann, ben].map(({ userId }) => ({
        id: crypto.randomUUID(),
        teamId,
        userId,
        createdAt: new Date(),
      }))
    );
    // A team both are in: still never recalled where others read the answer.
    await added(`Depot ${depot} opens at ${teamMarker}`, {
      kind: "team",
      teamId,
    });
    await forEveryone(`${depot} ${companyMarker}`);
    const agentId = crypto.randomUUID();
    await requestGranted(idp, admin, {
      subject: { type: "agent", agentId },
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const provider = await fakeProvider(
      says("Noted."),
      says("Noted."),
      says("Noted.")
    );
    const stub = workspace(env, personalWorkspaceId(ann.userId));
    const question = `What about depot ${depot}?`;
    /**
     * For what `ask` asked: how many recalls its chat holds, as its last
     * request carried them, and which sources reached the model.
     */
    const sentFor = async (ask: () => Promise<unknown>) => {
      const before = provider.requests.length;
      await ask();
      const sent = provider.requests.slice(before).map(({ body }) => body);
      const bodies = JSON.stringify(sent);
      return {
        recalls: stringsIn(sent.at(-1)).filter((text) =>
          recallHeader.test(text)
        ).length,
        team: bodies.includes(teamMarker),
        company: bodies.includes(companyMarker),
      };
    };
    /** Ann asks in a group she and Ben are in, as its door does. */
    const inGroup = async (outsiders: boolean) =>
      await stub.askThrough(ann.userId, agentId, "teams", question, undefined, {
        thread: `19:${unique()}@thread.v2`,
        kind: "group",
        audience: { members: [ann.userId, ben.userId], outsiders },
      });

    let chatId = "";
    const named = await sentFor(async () => {
      ({ chatId } = await inGroup(false));
    });
    // The same chat, woken by a schedule or an event: no roster read for it.
    const unattended = await sentFor(
      async () => await stub.askUnattended(chatId, { text: question, model })
    );
    // Someone Grasp can't name as a member is in it: a guest, say.
    const withOutsider = await sentFor(async () => await inGroup(true));
    // What the shared chat's recall was recorded as reading: never who.
    const [recorded] = recallsIn(
      await eventsOf(agentId, (events) => recallsIn(events, chatId).length > 0),
      chatId
    );

    expect({
      named,
      unattended,
      withOutsider,
      recorded: {
        reads: recorded?.detail.reads,
        names: JSON.stringify(recorded).includes(ben.userId),
      },
    }).toStrictEqual({
      named: { recalls: 1, team: false, company: true },
      // Only the first question's recall, as the chat's history holds it.
      unattended: { recalls: 1, team: false, company: true },
      withOutsider: { recalls: 0, team: false, company: false },
      recorded: { reads: "company", names: false },
    });
  });

  it("withholds what a chat others share recalled once the whole company may no longer read it: narrowed to a team, or erased", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const teamId = crypto.randomUUID();
    const db = drizzle(env.DB);
    await db.insert(teams).values({
      id: teamId,
      name: `Team ${unique()}`,
      organizationId,
      createdAt: new Date(),
    });
    await db.insert(teamMembers).values({
      id: crypto.randomUUID(),
      teamId,
      userId: person.userId,
      createdAt: new Date(),
    });
    const agentId = crypto.randomUUID();
    await requestGranted(idp, admin, {
      subject: { type: "agent", agentId },
      object: { type: "platform" },
      actions: ["brain"],
      binding: "BRAIN",
    });
    const stub = workspace(env, personalWorkspaceId(person.userId));
    /**
     * A thread others share recalls a company source, `change` happens to
     * it, then the person asks there again of something else: whether the
     * second turn's requests still carry what the first recalled.
     */
    const resentAfter = async (
      change: (source: SourceRef, depot: string) => Promise<unknown>
    ) => {
      const depot = word();
      const marker = word();
      const source = await forEveryone(`${depot} ${marker}`);
      const provider = await fakeProvider(says("Noted."), says("Noted."));
      const thread = `19:${unique()}@thread.tacv2;messageid=${unique()}`;
      const ask = async (text: string) =>
        await stub.askThrough(
          person.userId,
          agentId,
          "teams",
          text,
          undefined,
          {
            thread,
            kind: "channel",
            audience: { members: [person.userId], outsiders: false },
          }
        );
      await ask(`What about depot ${depot}?`);
      const first = JSON.stringify(provider.requests.map(({ body }) => body));
      await change(source, depot);
      const before = provider.requests.length;
      await ask("Thanks, and what else is new?");
      const second = provider.requests.slice(before).map(({ body }) => body);
      return {
        recalled: first.includes(marker),
        answered: second.length > 0,
        resent: JSON.stringify(second).includes(marker),
      };
    };

    const unchanged = await resentAfter(async () => {
      // Nothing changes: what was recalled stays in the chat's history.
    });
    const narrowed = await resentAfter(async (source, depot) => {
      // A new version only a team may read, the person's own team even.
      await brainOf(inJurisdiction(env, env.BRAIN_STORE)).addSource({
        source: `upload:${source.id}`,
        change: crypto.randomUUID(),
        text: `Depot ${depot} now only for the team.`,
        access: { kind: "audience", group: `team:${teamId}` },
      });
    });
    const erased = await resentAfter(async (source) => {
      await eraseSource(env, {
        source,
        readers: { kind: "team", teamId },
        reason: "deleted",
      });
    });

    expect({ unchanged, narrowed, erased }).toStrictEqual({
      unchanged: { recalled: true, answered: true, resent: true },
      narrowed: { recalled: true, answered: true, resent: false },
      erased: { recalled: true, answered: true, resent: false },
    });
  });

  it("withholds what a chat others share recalled once no roster is kept for it, mid-turn even, and keeps it in a direct message, which keeps none", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const stub = workspace(env, personalWorkspaceId(person.userId));
    /**
     * A chat at `place` recalls a company source in its first turn; in its
     * second, `between` happens once the model has the turn's first
     * request, and the model runs code: how that turn ends, and whether
     * the request after the code, if any, still carries what the first
     * turn recalled. The second asks nothing to recall, so the first
     * turn's recall is all the chat's withheld event counts.
     */
    const resentAfter = async (
      place: ChatPlace,
      between: (chatId: string) => Promise<unknown>
    ) => {
      const depot = word();
      const marker = word();
      await forEveryone(`${depot} ${marker}`);
      const agentId = crypto.randomUUID();
      await requestGranted(idp, admin, {
        subject: { type: "agent", agentId },
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      });
      let chatId = "";
      const provider = await answeringProvider(async (requests) => {
        if (requests.length === 1) {
          return says("Noted.");
        }
        if (requests.length === 2) {
          await between(chatId);
          return codeStep("export default async () => 1;");
        }
        return requests.length === 3 ? says("Done.") : undefined;
      });
      const ask = async (text: string) =>
        await stub.askThrough(
          person.userId,
          agentId,
          "teams",
          text,
          undefined,
          place
        );
      ({ chatId } = await ask(`What about depot ${depot}?`));
      const turn = await outcome(ask("?"));
      const [first = "", second = "", last] = provider.requests.map(
        ({ body }) => JSON.stringify(body)
      );
      return {
        chatId,
        agentId,
        said: {
          recalled: first.includes(marker),
          resentFirst: second.includes(marker),
          turn,
          afterCode:
            last === undefined
              ? null
              : {
                  resent: last.includes(marker),
                  withheld: last.includes(withheldResult),
                },
        },
      };
    };
    const group = (): ChatPlace => ({
      thread: `19:${unique()}@thread.v2`,
      kind: "group",
      audience: { members: [person.userId], outsiders: false },
    });
    const kept = await resentAfter(group(), async () => {
      // Nothing changes: the roster stays kept.
    });
    const dropped = await resentAfter(group(), dropRoster);
    const direct = await resentAfter({ kind: "direct" }, dropRoster);

    // Audited for the chat as one event, with its cause: no roster kept.
    const events = await eventsOf(
      dropped.agentId,
      (all) => withheldIn(all, dropped.chatId).length > 0
    );

    const sent = { resent: true, withheld: false };
    expect({
      kept: kept.said,
      dropped: dropped.said,
      direct: direct.said,
      audited: withheldIn(events, dropped.chatId).map(({ detail }) => detail),
    }).toStrictEqual({
      kept: { recalled: true, resentFirst: true, turn: "ok", afterCode: sent },
      // As a first turn refuses a roster it couldn't read: the turn under
      // way sent it already, so it stops, and nothing more is sent.
      dropped: {
        recalled: true,
        resentFirst: true,
        turn: "agent.history_revoked",
        afterCode: null,
      },
      // A chat nobody else shares keeps no roster: the company's own.
      direct: {
        recalled: true,
        resentFirst: true,
        turn: "ok",
        afterCode: sent,
      },
      audited: [
        allRecalledWithheld(
          events,
          dropped.chatId,
          personalWorkspaceId(person.userId),
          { audience: "unkept" }
        ),
      ],
    });
  });

  it("says why a chat others share withheld what it recalled when someone unnamed joins it, and gives no audience for a source narrowed there", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const { teamId } = await teamOf(person.userId);
    const stub = workspace(env, personalWorkspaceId(person.userId));
    /**
     * A group chat recalls a company source; `change` happens to it, then
     * the person asks there again, as one with `outsiders` in it: the
     * chat's withheld events.
     */
    const withheldAfter = async (
      change: (source: SourceRef, depot: string) => Promise<unknown>,
      outsiders: boolean
    ) => {
      const depot = word();
      const source = await forEveryone(`${depot} ${word()}`);
      const agentId = crypto.randomUUID();
      await requestGranted(idp, admin, {
        subject: { type: "agent", agentId },
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      });
      await fakeProvider(says("Noted."), says("Ok."));
      const thread = `19:${unique()}@thread.v2`;
      const ask = async (text: string, unnamed: boolean) =>
        await stub.askThrough(
          person.userId,
          agentId,
          "teams",
          text,
          undefined,
          {
            thread,
            kind: "group",
            audience: { members: [person.userId], outsiders: unnamed },
          }
        );
      const { chatId } = await ask(`What about depot ${depot}?`, false);
      await change(source, depot);
      await ask("?", outsiders);
      const events = await eventsOf(
        agentId,
        (all) => withheldIn(all, chatId).length > 0
      );
      return { chatId, events };
    };

    const joined = await withheldAfter(leftAlone, true);
    const narrowed = await withheldAfter(async (source, depot) => {
      await narrowedToTeam(source, depot, teamId);
    }, false);
    const at = personalWorkspaceId(person.userId);

    expect({
      joined: withheldIn(joined.events, joined.chatId).map(
        ({ detail }) => detail
      ),
      narrowed: withheldIn(narrowed.events, narrowed.chatId).map(
        ({ detail }) => detail
      ),
    }).toStrictEqual({
      // Everything the recall as the company handed over, for the guest.
      joined: [
        allRecalledWithheld(joined.events, joined.chatId, at, {
          audience: "outsiders",
        }),
      ],
      // The narrowed source alone: its cause is the source's own event.
      narrowed: [{ workspace: at, runs: 1, sources: 1, passages: 1 }],
    });
  });

  it("withholds what a chat's code or search recalled in a direct message once the whole company may no longer read it", async () => {
    const admin = await signedInApi(idp, "admin");
    /**
     * In a new person's Teams direct message, code (`env.brain.recall`)
     * or the `searchBrain` tool recalls a company source; `change`
     * happens to it; they ask again of something else: whether the second
     * turn's requests still carry what the first recalled.
     */
    const resentAfter = async (
      way: "code" | "tool",
      change: (
        source: SourceRef,
        depot: string,
        teamId: string
      ) => Promise<unknown>
    ) => {
      const person = await signedInWithRole(idp, "user");
      const teamId = crypto.randomUUID();
      const db = drizzle(env.DB);
      await db.insert(teams).values({
        id: teamId,
        name: `Team ${unique()}`,
        organizationId,
        createdAt: new Date(),
      });
      await db.insert(teamMembers).values({
        id: crypto.randomUUID(),
        teamId,
        userId: person.userId,
        createdAt: new Date(),
      });
      const agentId = crypto.randomUUID();
      await requestGranted(idp, admin, {
        subject: { type: "agent", agentId },
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      });
      const depot = word();
      const marker = word();
      const source = await forEveryone(`${depot} ${marker}`);
      const asked = { question: depot, budget: { tokens: 800 } };
      const step =
        way === "code"
          ? codeStep(
              `export default async (self, env) => { const pack = await env.brain.recall(${JSON.stringify(asked)}); return pack.items.map(({ text }) => text).join(" | "); };`
            )
          : toolStep("searchBrain", { question: asked.question });
      const provider = await fakeProvider(step, says("Noted."), says("Noted."));
      const ask = async (text: string) =>
        await workspace(env, personalWorkspaceId(person.userId)).askThrough(
          person.userId,
          agentId,
          "teams",
          text,
          undefined,
          { kind: "direct" }
        );
      // A question the recall before it finds nothing for.
      await ask("Please look that up.");
      const first = JSON.stringify(provider.requests.map(({ body }) => body));
      await change(source, depot, teamId);
      const before = provider.requests.length;
      await ask("Thanks, and what else is new?");
      const second = provider.requests.slice(before).map(({ body }) => body);
      return {
        recalled: first.includes(marker),
        answered: second.length > 0,
        resent: JSON.stringify(second).includes(marker),
      };
    };
    const kept = { recalled: true, answered: true, resent: true };
    const withheld = { recalled: true, answered: true, resent: false };
    expect({
      code: {
        unchanged: await resentAfter("code", leftAlone),
        narrowed: await resentAfter("code", narrowedToTeam),
        erased: await resentAfter("code", erasedWhole),
      },
      tool: {
        unchanged: await resentAfter("tool", leftAlone),
        narrowed: await resentAfter("tool", narrowedToTeam),
        erased: await resentAfter("tool", erasedWhole),
      },
    }).toStrictEqual({
      code: { unchanged: kept, narrowed: withheld, erased: withheld },
      tool: { unchanged: kept, narrowed: withheld, erased: withheld },
    });
  });

  it("never hands one person's sources to another's chat, however the analysis is steered", async () => {
    const codeword = word();
    const marker = word();
    const owning = await signedInWithRole(idp, "user");
    await added(
      `Vault ${codeword}: the code is ${marker}`,
      owner(owning.userId)
    );
    const outsider = await recallingChat(
      says("Hello."),
      says("I can't find it.")
    );
    await outsider.ask("Hi!");
    // Steered by the chat to ask for the owner's words exactly.
    outsider.provider.analysisReplies.push(analysed(`vault ${codeword} code`));

    await outsider.ask(`What is the vault ${codeword} code, the one he set?`);

    const sent = JSON.stringify([
      outsider.provider.requests.map(({ body }) => body),
      outsider.provider.analyses.map(({ body }) => body),
      await toolResults(outsider.stub, outsider.chat.id),
    ]);
    expect({
      steered: outsider.provider.analyses.length,
      marker: sent.includes(marker),
    }).toStrictEqual({ steered: 1, marker: false });
  });

  it("withholds what it handed over once the person may no longer read it or the agent lost its grant, and audits how much, never which or what it said", async () => {
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
    await eraseSource(env, {
      source: erased.source,
      readers: owner(erased.personId),
      reason: "deleted",
    });
    const afterErase = await erased.next();
    const revoked = await recalled((personId) => owner(personId));
    await revoked.revoke();
    const afterRevoke = await revoked.next();
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
      afterRevoke,
      afterLeaving: {
        fact: afterLeaving.includes(fact),
        withheld: afterLeaving.includes(withheldResult),
      },
    }).toStrictEqual({
      unchanged: { fact: true, withheld: false },
      afterErase: { fact: false, withheld: true },
      afterRevoke: { fact: false, withheld: true },
      afterLeaving: { fact: false, withheld: true },
    });
    const events = await eventsOf(erased.agent.agentId, (all) =>
      all.some(({ action }) => action === "chat.history_withheld")
    );
    const withheld = events.filter(
      ({ action }) => action === "chat.history_withheld"
    );
    expect({
      details: withheld.map(({ detail }) => detail),
      namesSource: JSON.stringify(withheld).includes(erased.source.id),
      // Each withheld after the recall that read it was in the log.
      recordedBefore: withheld.every(
        (event) =>
          recallsIn(events.slice(0, events.indexOf(event)), erased.chat.id)
            .length > 0
      ),
    }).toStrictEqual({
      details: [{ workspace: erased.id, runs: 1, sources: 1, passages: 1 }],
      namesSource: false,
      recordedBefore: true,
    });
  });
});

/** The shared store, where a team's memories are kept. */
const shared = () => brainOf(inJurisdiction(env, env.BRAIN_STORE));

/** A memory to add about the customer of an add (`rememberedAbout`). */
interface Said {
  statement: string;
  /** Its status, a one-value attribute: two lineages saying two contest it. */
  status?: string;
  /** The source it rests on, at version 1, its text holding the statement. */
  source?: SourceRef;
}

/**
 * Adds memories that `group` may read about the customer `name` (a new
 * one), each a system's word or resting on its source: their ids, in the
 * order given.
 */
const rememberedAbout = async (
  group: string,
  name: string,
  said: readonly Said[]
): Promise<string[]> => {
  const { memories } = await shared().addMemories({
    change: crypto.randomUUID(),
    access: { kind: "audience", group },
    entities: [{ key: "c", kind: "customer", names: [name] }],
    memories: said.map(({ statement, status, source }) => ({
      about: "c",
      ...(status === undefined ? {} : { attribute: "status", value: status }),
      type: "fact" as const,
      statement,
      speaker: { kind: "system" as const },
      basis:
        source === undefined
          ? { kind: "writer" as const, writer: "crm" }
          : {
              kind: "source" as const,
              source: `${source.producer}:${source.id}`,
              version: 1,
              quote: statement,
            },
    })),
  });
  return memories;
};

/** Adds a memory that `group` may read, `statement`, about a customer of its own. */
const remembered = async (group: string, statement: string) =>
  await rememberedAbout(group, `Depot ${word()}`, [{ statement }]);

/** What the model is handed of a recall, as far as these tests read it. */
const handedSchema = z.object({
  evidence: z.array(z.object({ source: z.string(), version: z.number() })),
  memories: z.array(
    z.object({
      memory: z.string(),
      statement: z.string(),
      quote: z.string().nullable(),
      source: z.string().nullable(),
      version: z.number().nullable(),
      said: z.string().nullable(),
      contested: z.boolean(),
    })
  ),
  contested: z.array(
    z.object({ attribute: z.string(), memories: z.array(z.string()) })
  ),
  notFound: z.array(z.string()),
});

/** What the recall before the question handed the model in `body`, parsed. */
const handedIn = (body: unknown) => {
  const handed = recallIn(body) ?? "";
  return handedSchema.parse(JSON.parse(handed.slice(handed.indexOf("{"))));
};

/** The budget both passes of the merge tests recall within. */
const mergeBudget = { tokens: 3000 };

// Memories before a question (GRA-1864): the pack as recall packs it,
// passages and memories within one budget, each memory with what it rests
// on and the contested facts among them. From the ways it can fail: a
// question only a memory answers reaches the model with no evidence, or
// its words said not found; a contested fact is shown one-sided; the
// audit log counts what wasn't handed over.
describe("the recall before a question hands over memories", setUpTime, () => {
  it("hands the model what only a memory answers, with what it rests on, counts its words found, and audits how many it handed over", async () => {
    const depot = word();
    const chat = await recallingChat();
    const statement = `Depot ${depot} opens at seven`;
    const { memory } = await rememberAs(env, chat.personId, {
      change: crypto.randomUUID(),
      about: { kind: "customer", names: [`Depot ${depot}`] },
      type: "fact",
      statement,
      quote: statement,
    });
    let logged: Promise<AuditEvent[]> | undefined;
    const provider = await answeringProvider(() => {
      logged ??= loggedEvents();
      return says("Seven.");
    });

    await chat.ask(`When does depot ${depot} open?`);

    const handed = handedIn(provider.requests[0]?.body);
    const hit = handed.memories.find((each) => each.memory === memory);
    const [event] = recallsIn((await logged) ?? [], chat.chat.id);
    expect({
      hit: hit === undefined ? undefined : { ...hit, contested: undefined },
      depotNotFound: handed.notFound.includes(depot),
      counts: {
        versions: event?.detail.versions,
        memories: event?.detail.memories,
      },
      saysWhat: JSON.stringify(event).includes(depot),
    }).toStrictEqual({
      hit: {
        memory,
        statement,
        quote: statement,
        source: null,
        version: null,
        said: "you",
        contested: undefined,
      },
      depotNotFound: false,
      counts: {
        versions: new Set(
          handed.evidence.map(({ source, version }) => `${source}@${version}`)
        ).size,
        memories: handed.memories.length,
      },
      saysWhat: false,
    });
  });

  it("hands over a fact sources disagree on with every side, each citing its source's version", async () => {
    const chat = await recallingChat(says("They disagree."));
    const { readers, group } = await teamOf(chat.personId);
    const depot = word();
    const [open, closed] = [
      `Depot ${depot} is open all winter`,
      `Depot ${depot} is closed in winter`,
    ];
    const [one, other] = await Promise.all([
      added(open, readers),
      added(closed, readers),
    ]);
    const [openMemory = "", closedMemory = ""] = await rememberedAbout(
      group,
      `Depot ${depot}`,
      [
        { statement: open, status: "open", source: one },
        { statement: closed, status: "closed", source: other },
      ]
    );

    await chat.ask(`Is depot ${depot} open in winter?`);

    const handed = handedIn(chat.provider.requests[0]?.body);
    const sideOf = (memory: string) => {
      const side = handed.memories.find((each) => each.memory === memory);
      return side === undefined
        ? undefined
        : {
            source: side.source,
            version: side.version,
            contested: side.contested,
          };
    };
    expect({
      open: sideOf(openMemory),
      closed: sideOf(closedMemory),
      fact: handed.contested
        .find(({ memories }) => memories.includes(openMemory))
        ?.memories.toSorted(),
    }).toStrictEqual({
      open: { source: `upload:${one.id}`, version: 1, contested: true },
      closed: { source: `upload:${other.id}`, version: 1, contested: true },
      fact: [openMemory, closedMemory].toSorted(),
    });
  });

  it("hands a chat app's direct message and a thread others read only the memories the whole company may read", async () => {
    const admin = await signedInApi(idp, "admin");
    const person = await signedInWithRole(idp, "user");
    const { group } = await teamOf(person.userId);
    const depot = word();
    const ownStatement = `Depot ${depot} keeps the person's own note ${word()}`;
    const teamStatement = `Depot ${depot} opens at ${word()}`;
    await rememberAs(env, person.userId, {
      change: crypto.randomUUID(),
      about: { kind: "customer", names: [`Depot ${depot}`] },
      type: "fact",
      statement: ownStatement,
      quote: ownStatement,
    });
    await rememberedAbout(group, `Depot ${depot}`, [
      { statement: teamStatement },
    ]);
    const companyStatement = `Depot ${depot} is open to everyone ${word()}`;
    await rememberedAbout("company", `Depot ${depot}`, [
      { statement: companyStatement },
    ]);
    const question = `What about depot ${depot}?`;
    /** What the model was sent of each memory, asked through `platform`. */
    const sent = async (platform: string, sharedThread: boolean) => {
      const agentId = crypto.randomUUID();
      await requestGranted(idp, admin, {
        subject: { type: "agent", agentId },
        object: { type: "platform" },
        actions: ["brain"],
        binding: "BRAIN",
      });
      const provider = await fakeProvider(says("Noted."));
      await workspace(env, personalWorkspaceId(person.userId)).askThrough(
        person.userId,
        agentId,
        platform,
        question,
        undefined,
        sharedThread
          ? {
              thread: `C${unique()}`,
              kind: "group",
              audience: { members: [person.userId], outsiders: false },
            }
          : { kind: "direct" }
      );
      const bodies = JSON.stringify(provider.requests.map(({ body }) => body));
      return {
        own: bodies.includes(ownStatement),
        team: bodies.includes(teamStatement),
        company: bodies.includes(companyStatement),
      };
    };

    const ownChat = await recallingChatOf(person.userId, says("Noted."));
    await ownChat.ask(question);
    const web = JSON.stringify(
      ownChat.provider.requests.map(({ body }) => body)
    );

    expect({
      web: {
        own: web.includes(ownStatement),
        team: web.includes(teamStatement),
        company: web.includes(companyStatement),
      },
      direct: await sent("slack", false),
      thread: await sent("slack", true),
    }).toStrictEqual({
      web: { own: true, team: true, company: true },
      // Outside their own chat, the company's alone (GRA-1820).
      direct: { own: false, team: false, company: true },
      thread: { own: false, team: false, company: true },
    });
  });
});

/**
 * A chat of `personId`'s whose first turn asked `question`, what its
 * recall handed the model, and `next`: whether the turn after still sends
 * each of `statements`, and whether a result was withheld.
 */
const recalledMemoryOf = async (
  personId: string,
  question: string,
  statements: readonly string[]
) => {
  const chat = await recallingChatOf(personId, says("Noted."), says("Ok."));
  await chat.ask(question);
  const handed = handedIn(chat.provider.requests[0]?.body);
  const next = async () => {
    const before = chat.provider.requests.length;
    await chat.ask("Thanks!");
    const body = JSON.stringify(chat.provider.requests[before]?.body);
    return {
      sent: statements.map((statement) => body.includes(statement)),
      withheld: body.includes(withheldResult),
    };
  };
  return { ...chat, handed, next };
};

// Memories a recall handed over, read again on every later request
// (history-access.ts `brainMemoryRead`), as a passage is: withheld once
// the person may no longer read it or its writer retired it; kept when a
// newer memory replaced it (a correction, a source's newer version
// extracted again), as an older version of a source stays readable. From
// the ways it can fail: a memory the person may no longer read reaches
// the model again; a routine re-sync hides an earlier answer as if the
// person could no longer read it; a contested fact loses one side in
// history; the check decides from what it reads now rather than the
// store and memory pinned.
describe("memories a recall handed over, read again", setUpTime, () => {
  it("withholds a memory of the person's own once it is retired or its source erased, keeps one a correction replaced, and audits how many, never which or what it said", async () => {
    const person = await signedInWithRole(idp, "user");
    /** A memory of theirs about a depot of its own, recalled by a chat. */
    const recalledOwn = async () => {
      const depot = word();
      const statement = `Depot ${depot} is ${word()}`;
      const kept = await rememberAs(env, person.userId, {
        change: crypto.randomUUID(),
        about: { kind: "customer", names: [`Depot ${depot}`] },
        attribute: "status",
        value: "open",
        type: "fact",
        statement,
        quote: statement,
      });
      const chat = await recalledMemoryOf(
        person.userId,
        `What is the status of depot ${depot}?`,
        [statement]
      );
      return { ...chat, ...kept };
    };

    // Each chat's next turn before the next chat: the fake provider is
    // the latest chat's.
    const unchanged = await recalledOwn();
    const unchangedNext = await unchanged.next();
    const retired = await recalledOwn();
    await forgetAs(env, person.userId, retired.memory);
    const retiredNext = await retired.next();
    const corrected = await recalledOwn();
    await rememberAs(env, person.userId, {
      change: crypto.randomUUID(),
      about: { id: corrected.entity, kind: "customer" },
      attribute: "status",
      value: "closed",
      type: "fact",
      statement: `It closed ${word()}`,
      quote: "It closed",
    });
    const correctedNext = await corrected.next();
    // A memory of theirs drawn from a source of their own, which they
    // then erase.
    const depot = word();
    const drawn = `Depot ${depot} keeps its keys at the gate`;
    const own = await added(drawn, owner(person.userId));
    const {
      memories: [drawnMemory = ""],
    } = await personalBrainOf(
      inJurisdiction(env, env.BRAIN_STORE),
      person.userId
    ).addMemories({
      change: crypto.randomUUID(),
      access: { kind: "owner", person: person.userId },
      entities: [{ key: "c", kind: "customer", names: [`Depot ${depot}`] }],
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
    const erased = await recalledMemoryOf(
      person.userId,
      `Where does depot ${depot} keep its keys?`,
      [drawn]
    );
    await eraseSource(env, {
      source: own,
      readers: owner(person.userId),
      reason: "deleted",
    });
    const erasedNext = await erased.next();

    expect({
      recalled: [
        ...[unchanged, retired, corrected].map(({ handed, memory }) =>
          handed.memories.some((each) => each.memory === memory)
        ),
        erased.handed.memories.some((each) => each.memory === drawnMemory),
      ],
      unchanged: unchangedNext,
      retired: retiredNext,
      // The corrected fact arrives with the next recall that finds it.
      corrected: correctedNext,
      erased: erasedNext,
    }).toStrictEqual({
      recalled: [true, true, true, true],
      unchanged: { sent: [true], withheld: false },
      retired: { sent: [false], withheld: true },
      corrected: { sent: [true], withheld: false },
      erased: { sent: [false], withheld: true },
    });
    const events = await eventsOf(retired.agent.agentId, (all) =>
      all.some(({ action }) => action === "chat.history_withheld")
    );
    const withheld = events.filter(
      ({ action }) => action === "chat.history_withheld"
    );
    expect({
      details: withheld.map(({ detail }) => detail),
      namesMemory: JSON.stringify(withheld).includes(retired.memory),
      saysWhat: JSON.stringify(withheld).includes("Depot"),
    }).toStrictEqual({
      details: [{ workspace: retired.id, runs: 1, sources: 1, memories: 1 }],
      namesMemory: false,
      saysWhat: false,
    });
  });

  it("audits narrowing one source that many recalled memories rest on as one event for the turn, with how many it withheld, and writes none again when the history is checked again after the log took it", async () => {
    const person = await signedInWithRole(idp, "user");
    const { readers, group } = await teamOf(person.userId);
    const depot = word();
    const statements = Array.from(
      { length: 12 },
      (_, at) => `Depot ${depot} bay ${at + 1} holds ${word()}`
    );
    const text = statements.join("\n");
    const source = await added(text, readers);
    const memories = await rememberedAbout(
      group,
      `Depot ${depot}`,
      statements.map((statement) => ({ statement, source }))
    );
    const chat = await recallingChatOf(
      person.userId,
      says("Noted."),
      says("Ok."),
      says("Again.")
    );
    await chat.ask(`What does depot ${depot} hold?`);
    const handed = handedIn(chat.provider.requests[0]?.body);
    const handedMemories = handed.memories.filter(({ memory }) =>
      memories.includes(memory)
    );
    const head = await logHead();
    // Narrowed: a new version only another team may read.
    const outsider = await signedInWithRole(idp, "user");
    const { readers: elsewhere } = await teamOf(outsider.userId);
    await addSource(env, {
      source,
      change: crypto.randomUUID(),
      text,
      readers: elsewhere,
    });
    await chat.ask("Thanks!");
    // In the log: the outbox drained.
    await eventsOf(
      chat.agent.agentId,
      (events) => withheldIn(events, chat.chat.id).length > 0
    );
    // Checked again, as the chat's object does before every request (a
    // turn a restart cut short set up again among them), then a turn.
    await chat.stub.turnGuard(chat.chat.id);
    await chat.ask("And again?");
    const after = await eventsAfter(head);
    const withheld = withheldIn(after, chat.chat.id);
    const [detail] = withheld.map((event) => event.detail);
    const said = JSON.stringify(withheld);

    expect({
      handedMany: handedMemories.length > 1,
      events: withheld.length,
      runs: detail?.runs,
      memories: detail?.memories,
      // Every source it counts, by kind: the memories and the passages.
      sources:
        detail?.sources === Number(detail?.memories) + Number(detail?.passages),
      gaps: after.filter(({ action }) => action === "audit.gap").length,
      saysWhat: said.includes(depot),
      namesMemory: memories.some((memory) => said.includes(memory)),
      namesSource: said.includes(source.id),
    }).toStrictEqual({
      handedMany: true,
      events: 1,
      runs: 1,
      memories: handedMemories.length,
      sources: true,
      gaps: 0,
      saysWhat: false,
      namesMemory: false,
      namesSource: false,
    });
  });

  it("audits checks that overlap as one event for one narrowed source, and a second source narrowed after as a second, its runs counted once", async () => {
    const person = await signedInWithRole(idp, "user");
    const { readers, group } = await teamOf(person.userId);
    const depot = word();
    /** Six statements about the depot's `place`, and the source they rest on. */
    const restingOn = async (place: string) => {
      const statements = Array.from(
        { length: 6 },
        (_, at) => `Depot ${depot} ${place} ${at + 1} holds ${word()}`
      );
      const text = statements.join("\n");
      return { statements, text, source: await added(text, readers) };
    };
    const [bays, docks] = [await restingOn("bay"), await restingOn("dock")];
    const memories = await rememberedAbout(group, `Depot ${depot}`, [
      ...bays.statements.map((statement) => ({
        statement,
        source: bays.source,
      })),
      ...docks.statements.map((statement) => ({
        statement,
        source: docks.source,
      })),
    ]);
    const [bayMemories, dockMemories] = [
      memories.slice(0, bays.statements.length),
      memories.slice(bays.statements.length),
    ];
    const chat = await recallingChatOf(person.userId, says("Noted."));
    await chat.ask(`What does depot ${depot} hold?`);
    const handed = handedIn(chat.provider.requests[0]?.body);
    /** What a withheld event counts once `side` is narrowed. */
    const countsFor = (
      side: typeof bays,
      ids: readonly string[],
      runs: number
    ) => {
      const memoriesOf = handed.memories.filter(({ memory }) =>
        ids.includes(memory)
      ).length;
      const passages = new Set(
        handed.evidence
          .filter(({ source }) => source.includes(side.source.id))
          .map(({ version }) => version)
      ).size;
      return {
        workspace: chat.id,
        runs,
        sources: memoriesOf + passages,
        ...(memoriesOf > 0 ? { memories: memoriesOf } : {}),
        ...(passages > 0 ? { passages } : {}),
      };
    };
    const outsider = await signedInWithRole(idp, "user");
    const { readers: elsewhere } = await teamOf(outsider.userId);
    const narrow = async (side: typeof bays) => {
      await addSource(env, {
        source: side.source,
        change: crypto.randomUUID(),
        text: side.text,
        readers: elsewhere,
      });
    };
    const head = await logHead();

    await narrow(bays);
    // Four checks at once, as the chat's object makes one before every
    // request: each reads the rows before any marks them.
    const guards = await Promise.all(
      Array.from(
        { length: 4 },
        async () => await chat.stub.turnGuard(chat.chat.id)
      )
    );
    await narrow(docks);
    await chat.stub.turnGuard(chat.chat.id);
    const after = await eventsAfter(head);
    const recallRun = recallRunIn(chat.provider.requests[0]?.body);

    expect({
      recalledBoth: [bayMemories, dockMemories].map((ids) =>
        handed.memories.some(({ memory }) => ids.includes(memory))
      ),
      guards: guards.map(({ withheld }) => withheld),
      events: withheldIn(after, chat.chat.id).map(({ detail }) => detail),
      gaps: after.filter(({ action }) => action === "audit.gap").length,
    }).toStrictEqual({
      recalledBoth: [true, true],
      guards: Array.from({ length: 4 }, () => [recallRun]),
      events: [
        countsFor(bays, bayMemories, 1),
        // The same run, withheld by the first event already.
        countsFor(docks, dockMemories, 0),
      ],
      gaps: 0,
    });
  });

  it("withholds a team's memories once a source one side of their fact rests on is erased or narrowed, or the person leaves the team, every side of it, and keeps them when that source is edited and extracted again", async () => {
    const db = drizzle(env.DB);
    /** A contested fact a team of `personId`'s may read, recalled by a chat. */
    const recalledFact = async (personId: string) => {
      const { readers, group, teamId } = await teamOf(personId);
      const depot = word();
      const [open, closed] = [
        `Depot ${depot} is open all winter`,
        `Depot ${depot} is closed in winter`,
      ];
      const [one, other] = await Promise.all([
        added(open, readers),
        added(closed, readers),
      ]);
      const memories = await rememberedAbout(group, `Depot ${depot}`, [
        { statement: open, status: "open", source: one },
        { statement: closed, status: "closed", source: other },
      ]);
      const chat = await recalledMemoryOf(
        personId,
        `Is depot ${depot} open in winter?`,
        [open, closed]
      );
      return {
        ...chat,
        readers,
        group,
        name: `Depot ${depot}`,
        teamId,
        one,
        open,
        memories,
      };
    };
    const [ann, ben, cas, dee, eve] = await Promise.all([
      signedInWithRole(idp, "user"),
      signedInWithRole(idp, "user"),
      signedInWithRole(idp, "user"),
      signedInWithRole(idp, "user"),
      signedInWithRole(idp, "user"),
    ]);

    // Each chat's next turn before the next chat: the fake provider is
    // the latest chat's.
    const unchanged = await recalledFact(ann.userId);
    const unchangedNext = await unchanged.next();
    const erased = await recalledFact(ben.userId);
    await eraseSource(env, {
      source: erased.one,
      readers: erased.readers,
      reason: "deleted",
    });
    const erasedNext = await erased.next();
    const narrowed = await recalledFact(cas.userId);
    const outsider = await signedInWithRole(idp, "user");
    const { readers: elsewhere } = await teamOf(outsider.userId);
    await addSource(env, {
      source: narrowed.one,
      change: crypto.randomUUID(),
      text: narrowed.open,
      readers: elsewhere,
    });
    const narrowedNext = await narrowed.next();
    const leaving = await recalledFact(dee.userId);
    await db
      .delete(teamMembers)
      .where(
        and(
          eq(teamMembers.teamId, leaving.teamId),
          eq(teamMembers.userId, dee.userId)
        )
      );
    const leavingNext = await leaving.next();
    // The same document edited, for the same readers, and extracted again:
    // the memory of its first version ends, as the version does.
    const resynced = await recalledFact(eve.userId);
    await addSource(env, {
      source: resynced.one,
      change: crypto.randomUUID(),
      text: `${resynced.open}.`,
      readers: resynced.readers,
    });
    await shared().addMemories({
      change: crypto.randomUUID(),
      access: { kind: "audience", group: resynced.group },
      entities: [{ key: "c", kind: "customer", names: [resynced.name] }],
      memories: [
        {
          about: "c",
          attribute: "status",
          value: "open",
          type: "fact",
          statement: resynced.open,
          speaker: { kind: "system" },
          basis: {
            kind: "source",
            source: `upload:${resynced.one.id}`,
            version: 2,
            quote: resynced.open,
          },
        },
      ],
      extracted: { source: `upload:${resynced.one.id}`, version: 2 },
    });
    const resyncedNext = await resynced.next();

    expect({
      recalled: [unchanged, erased, narrowed, leaving, resynced].map(
        ({ handed, memories }) =>
          memories.every((memory) =>
            handed.memories.some((each) => each.memory === memory)
          )
      ),
      unchanged: unchangedNext,
      erased: erasedNext,
      narrowed: narrowedNext,
      leaving: leavingNext,
      resynced: resyncedNext,
    }).toStrictEqual({
      recalled: [true, true, true, true, true],
      unchanged: { sent: [true, true], withheld: false },
      erased: { sent: [false, false], withheld: true },
      narrowed: { sent: [false, false], withheld: true },
      leaving: { sent: [false, false], withheld: true },
      resynced: { sent: [true, true], withheld: false },
    });
  });
});

/** Where an item of a pack is: its source, version and place. */
const placeOf = (item: RecalledItem): string =>
  JSON.stringify([item.source, item.version, item.position]);

/** A memory of a pack, by its store and id. */
const memoryKeyOf = (memory: RecalledMemory): string =>
  JSON.stringify([memory.store, memory.memory]);

/** Where each of `pack`'s passages is, and each of its memories, in its order. */
const keysOf = (pack: RecalledPack): string[] => [
  ...pack.items.map((item) => placeOf(item)),
  ...pack.memories.map((memory) => memoryKeyOf(memory)),
];

/** The person's recall for `question`, within `tokens`. */
const recalledBy =
  (personId: string, tokens: number) => async (question: string) =>
    await recallAs(env, personId, {
      question,
      budget: { tokens },
      personal: false,
    });

/**
 * The second pass as the chat makes it: within what `first` left of
 * `mergeBudget`.
 */
const secondPassOf =
  (personId: string, first: RecalledPack) => async (question: string) =>
    await recalledBy(
      personId,
      mergeBudget.tokens - recalledTokens(first)
    )(question);

/** Each side of each contested fact `packs` list, sorted. */
const sidesOf = (...packs: RecalledPack[]): string[] =>
  [
    ...new Set(
      packs.flatMap(({ contested }) =>
        contested.flatMap(({ about, attribute, memories }) =>
          memories.map((side) => JSON.stringify([about, attribute, side]))
        )
      )
    ),
  ].toSorted();

/** `keys` each once, in the order each first appears. */
const onceEach = (keys: readonly string[]): string[] => [...new Set(keys)];

/**
 * What a merge of `first` and `second` must hold, whatever their shape:
 * within `budget`; every passage and memory of the first, in its order,
 * then the second's others in theirs; none showing less than either pass
 * handed over (a passage's every excerpt held by a copy kept of it, a
 * memory at least as full), so the second's `notFound` stays true; no
 * copy of a passage that another kept copy holds; and every side of
 * every contested fact either pass listed.
 */
const mergedHolds = (
  first: RecalledPack,
  second: RecalledPack,
  merged: RecalledPack,
  budget: number
) => {
  const firstKeys = keysOf(first);
  /** The tokens of `merged`'s copy of the memory at `key`. */
  const mergedTokens = (key: string): number =>
    recalledTokens({
      ...merged,
      items: [],
      memories: merged.memories.filter((memory) => memoryKeyOf(memory) === key),
    });
  /** The texts of `merged`'s copies of the passage at `place`. */
  const copiesAt = (place: string): string[] =>
    merged.items.flatMap((item) =>
      placeOf(item) === place ? [item.text] : []
    );
  return {
    within: recalledTokens(merged) <= budget,
    order:
      JSON.stringify(onceEach(keysOf(merged)).toSorted()) ===
        JSON.stringify(
          [
            ...firstKeys,
            ...keysOf(second).filter((key) => !firstKeys.includes(key)),
          ].toSorted()
        ) &&
      JSON.stringify(onceEach(merged.items.map((item) => placeOf(item)))) ===
        JSON.stringify([
          ...first.items.map((item) => placeOf(item)),
          ...second.items
            .map((item) => placeOf(item))
            .filter((key) => !firstKeys.includes(key)),
        ]) &&
      JSON.stringify(merged.memories.map((memory) => memoryKeyOf(memory))) ===
        JSON.stringify([
          ...first.memories.map((memory) => memoryKeyOf(memory)),
          ...second.memories
            .map((memory) => memoryKeyOf(memory))
            .filter((key) => !firstKeys.includes(key)),
        ]),
    // Never less of anything than either recall handed over: each
    // excerpt of a passage is held by a copy kept of it, and a memory's
    // kept copy is at least as full (it holds all the other does), so the
    // second's `notFound` stays true.
    noLess: [first, second].every(
      (pack) =>
        pack.items.every((item) =>
          copiesAt(placeOf(item)).some((text) => text.includes(item.text))
        ) &&
        pack.memories.every(
          (memory) =>
            mergedTokens(memoryKeyOf(memory)) >=
            recalledTokens({ ...pack, items: [], memories: [memory] })
        )
    ),
    // No copy of a passage another kept copy of it holds, and a memory
    // once.
    noRepeat:
      onceEach(merged.items.map((item) => placeOf(item))).every((place) =>
        copiesAt(place).every((text, at, copies) =>
          copies.every(
            (other, otherAt) => otherAt === at || !other.includes(text)
          )
        )
      ) &&
      onceEach(merged.memories.map((memory) => memoryKeyOf(memory))).length ===
        merged.memories.length,
    notFound:
      JSON.stringify(merged.notFound) === JSON.stringify(second.notFound),
    contested:
      JSON.stringify(sidesOf(merged)) ===
      JSON.stringify(sidesOf(first, second)),
    truncated: merged.truncated === (first.truncated || second.truncated),
  };
};

/** `pack`'s entries while they fit in `tokens`, as a pack. */
const within = (pack: RecalledPack, tokens: number): RecalledPack => {
  const kept: RecalledPack = { ...pack, items: [], memories: [] };
  for (const item of pack.items) {
    const more = { ...kept, items: [...kept.items, item] };
    if (recalledTokens(more) <= tokens) {
      kept.items = more.items;
    }
  }
  for (const memory of pack.memories) {
    const more = { ...kept, memories: [...kept.memories, memory] };
    if (recalledTokens(more) <= tokens) {
      kept.memories = more.memories;
    }
  }
  // Its contested facts as a pack lists them: those it holds more than
  // one side of.
  const facts = new Map<string, RecalledPack["contested"][number]>();
  for (const { about, attribute, memory, contested } of kept.memories) {
    if (contested && attribute !== null) {
      const key = JSON.stringify([about, attribute]);
      const fact = facts.get(key) ?? { about, attribute, memories: [] };
      facts.set(key, { ...fact, memories: [...fact.memories, memory] });
    }
  }
  kept.contested = [...facts.values()].filter(
    ({ memories: sides }) => sides.length > 1
  );
  return kept;
};

/** A part of the handbook's first passage, as recall gives it. */
const handbookPassage = (text: string, whole = false): RecalledItem => ({
  source: { producer: "upload", id: "handbook" },
  version: 1,
  position: 0,
  text,
  whole,
  found: "words",
});
/** `items` as a pack cut short. */
const cutPack = (items: RecalledItem[]): RecalledPack => ({
  items,
  memories: [],
  contested: [],
  notFound: [],
  truncated: true,
});

/** Every property `mergedHolds` checks, holding. */
const holding = {
  within: true,
  order: true,
  noLess: true,
  noRepeat: true,
  notFound: true,
  contested: true,
  truncated: true,
};

// The second pass's pack merged into the first's (`mergeRecalled`), from
// the ways it can fail: what both passes found is handed over twice, or
// as the shorter copy the budget paid for twice; the second pass overruns
// the budget the first left, or is cut so that its `notFound` counts
// words of what was left out; a contested fact loses a side; what the person may not read reaches the merged pack, or changes
// it at all.
describe("two recalls merged into one pack", setUpTime, () => {
  it("holds what both passes found once, the fuller copy, then the second's own, passages and memories alike", async () => {
    const person = await signedInWithRole(idp, "user");
    const { readers, group } = await teamOf(person.userId);
    const [first, second] = [word(), word()];
    await added(`Depot ${first} ships ${second}`, readers);
    await added(`Depot ${second} closes`, readers);
    await remembered(group, `Depot ${first} ships ${second} weekly`);
    await remembered(group, `Depot ${second} closes early`);
    const firstPack = await recalledBy(
      person.userId,
      mergeBudget.tokens
    )(first);
    const secondPack = await secondPassOf(person.userId, firstPack)(second);

    const merged = mergeRecalled(firstPack, secondPack);

    // Counted by how each was found: recall by meaning may find either
    // passage for either word too.
    expect({
      firstByWords: firstPack.memories.some(({ found }) => found === "words"),
      secondByWords: secondPack.memories.some(({ found }) => found === "words"),
      ...mergedHolds(firstPack, secondPack, merged, mergeBudget.tokens),
    }).toStrictEqual({
      firstByWords: true,
      secondByWords: true,
      ...holding,
    });
  });

  // Packs of every shape, sharing passages and memories, contested ones
  // among them, the second packed within what the first left: the merged
  // pack holds every property above.
  // A thin first pass can quote a passage's opening (found by meaning),
  // the rewritten question the answer later in the same passage: neither
  // excerpt holds the other, and both were paid for.
  it("keeps both excerpts of one passage when neither holds the other, and one when one does", () => {
    const opening = "The depot opens its doors to drivers.";
    const answer = "Keys are kept at the north gate.";
    const both = mergeRecalled(
      cutPack([handbookPassage(opening)]),
      cutPack([handbookPassage(answer)])
    );
    const held = mergeRecalled(
      cutPack([handbookPassage(opening)]),
      cutPack([handbookPassage(`${opening} ${answer}`, true)])
    );

    expect({
      both: both.items.map(({ text }) => text),
      held: held.items.map(({ text }) => text),
    }).toStrictEqual({
      both: [opening, answer],
      held: [`${opening} ${answer}`],
    });
  });

  it("never goes over the budget, and shows no less of anything than either pass, whatever their shape", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const count = (most: number): number => Math.floor(random() * (most + 1));
    // Each passage as its opening, its answer (two excerpts neither of
    // which holds the other, as two questions quote it) or whole, and each
    // memory without its quote or with it: a pass holds one copy of each.
    const items: RecalledItem[][] = Array.from({ length: 12 }, (_, index) => {
      const opening = `Opening ${index} ${"word ".repeat(count(60))}`.trim();
      const answer = `Answer ${index} ${"word ".repeat(count(60))}`.trim();
      const whole: RecalledItem = {
        source: { producer: "upload", id: `s${index}` },
        version: 1,
        position: 0,
        text: `${opening} ${"more ".repeat(count(40))}${answer}`,
        whole: true,
        found: "words",
      };
      return [
        { ...whole, text: opening, whole: false },
        { ...whole, text: answer, whole: false },
        whole,
      ];
    });
    const memories: RecalledMemory[][] = Array.from(
      { length: 12 },
      (_, index): RecalledMemory[] => {
        const quoted: RecalledMemory = {
          store: index % 2 === 0 ? "shared" : "own",
          memory: crypto.randomUUID(),
          about: `entity-${index % 3}`,
          attribute: index < 6 ? "status" : null,
          object: null,
          type: "fact",
          statement: "fact ".repeat(1 + count(60)),
          quote: "quote ".repeat(1 + count(30)),
          context: null,
          source: null,
          said: "system",
          writer: "crm",
          speaker: { kind: "system" },
          validFrom: null,
          validUntil: null,
          learnedAt: new Date(0),
          contested: index < 6,
          confirmed: false,
          found: "words",
        };
        return [{ ...quoted, quote: null }, quoted];
      }
    );
    /** Some of `copies`, each as one of its copies. */
    const some = <T>(copies: readonly T[][]): T[] =>
      copies
        .filter(() => random() < 0.4)
        .flatMap((each) => {
          const copy = each[count(each.length - 1)];
          return copy === undefined ? [] : [copy];
        });
    const packOf = (tokens: number): RecalledPack =>
      within(
        {
          items: some(items),
          memories: some(memories),
          contested: [],
          notFound: random() < 0.5 ? ["missing"] : [],
          truncated: random() < 0.2,
        },
        tokens
      );
    for (let round = 0; round < 300; round += 1) {
      const budget = 200 + count(2800);
      const first = packOf(budget);
      const second = packOf(budget - recalledTokens(first));

      expect(
        mergedHolds(first, second, mergeRecalled(first, second), budget)
      ).toStrictEqual(holding);
    }
  });

  it("is the same pack when the second pass's words reach what the person may not read", async () => {
    const person = await signedInWithRole(idp, "user");
    const { readers } = await teamOf(person.userId);
    const other = await signedInWithRole(idp, "user");
    const { readers: theirTeam, group: theirGroup } = await teamOf(
      other.userId
    );
    const [first, second, theirs] = [word(), word(), word()];
    await added(`Depot ${first} ships ${second}`, readers);
    await added(`Depot ${second} renews in March`, readers);
    const asked = async () => {
      const firstPack = await recalledBy(
        person.userId,
        mergeBudget.tokens
      )(first);
      return mergeRecalled(
        firstPack,
        await secondPassOf(person.userId, firstPack)(`${second} ${theirs}`)
      );
    };
    const before = await asked();
    // What only another team may read, holding both of the second pass's
    // words: a passage, and a memory.
    await added(
      `Depot ${second} ${theirs} keeps the other team's note`,
      theirTeam
    );
    await remembered(
      theirGroup,
      `Depot ${second} ${theirs} keeps another note`
    );

    expect(before.notFound).toContain(theirs);
    await expect(asked()).resolves.toStrictEqual(before);
  });
});
